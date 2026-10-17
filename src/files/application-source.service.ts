import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AccessControlService } from '../authorization/access-control.service';
import { normalizeApplicationPath } from '../common/source/path-safety';
import { PrismaService } from '../database/prisma.service';
import { SecretScannerService } from '../security/secret-scanner.service';

export interface GeneratedSourceFile {
  path: string;
  content: string;
  language?: string;
}

const MAX_GENERATED_FILES = 40;
const MAX_FILE_BYTES = 1_000_000;
const MAX_BATCH_BYTES = 4_000_000;

@Injectable()
export class ApplicationSourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly secrets: SecretScannerService,
  ) {}

  async applyGeneratedBatch(
    userId: string,
    applicationId: string,
    files: GeneratedSourceFile[],
    expectedRevisions: Record<string, number>,
  ) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    if (files.length < 1 || files.length > MAX_GENERATED_FILES) {
      throw new BadRequestException(`A generation batch must contain 1–${MAX_GENERATED_FILES} files.`);
    }

    const normalized = files.map((file) => {
      const path = normalizeApplicationPath(file.path);
      if (file.content.includes('\u0000')) throw new BadRequestException('Source files cannot contain NUL bytes.');
      this.secrets.assertNoSecrets(file.content);
      const bytes = Buffer.byteLength(file.content, 'utf8');
      if (bytes > MAX_FILE_BYTES) {
        throw new PayloadTooLargeException(`Generated file ${path} exceeds the 1 MB file limit.`);
      }
      return {
        path,
        content: file.content,
        language: file.language?.trim().slice(0, 80) || null,
        contentHash: createHash('sha256').update(file.content, 'utf8').digest('hex'),
        bytes,
      };
    });

    const uniquePaths = new Set(normalized.map((file) => file.path));
    if (uniquePaths.size !== normalized.length) {
      throw new BadRequestException('The generated batch contains duplicate file paths.');
    }
    if (normalized.reduce((sum, file) => sum + file.bytes, 0) > MAX_BATCH_BYTES) {
      throw new PayloadTooLargeException('Generated source batch exceeds the 4 MB total limit.');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const application = await tx.application.findFirst({
          where: {
            id: applicationId,
            status: { not: 'ARCHIVED' },
            project: { status: 'ACTIVE' },
          },
          select: { id: true, project: { select: { workspace: { select: { organizationId: true } } } } },
        });
        if (!application) throw new ForbiddenException('The application is not writable.');
        const membership = await tx.membership.findFirst({
          where: {
            userId,
            organizationId: application.project.workspace.organizationId,
            role: { in: this.access.writeRoles() },
          },
          select: { id: true },
        });
        if (!membership) throw new ForbiddenException('Write access was revoked before source persistence.');

        const results: Array<{
          id: string;
          path: string;
          revision: number;
          contentHash: string;
          created: boolean;
        }> = [];

        for (const file of normalized) {
          const current = await tx.applicationFile.findUnique({
            where: { applicationId_path: { applicationId, path: file.path } },
          });
          const hasExpectedRevision = Object.prototype.hasOwnProperty.call(expectedRevisions, file.path);
          const expectedRevision = expectedRevisions[file.path];

          if (hasExpectedRevision) {
            if (!current || current.isDeleted || current.revision !== expectedRevision) {
              throw new ConflictException(`Source file ${file.path} changed during generation; no files were applied.`);
            }
          } else if (current) {
            throw new ConflictException(`Source path ${file.path} appeared during generation; no files were applied.`);
          }

          if (!current) {
            const created = await tx.applicationFile.create({
              data: {
                applicationId,
                path: file.path,
                language: file.language,
                content: file.content,
                contentHash: file.contentHash,
                revision: 1,
                isDeleted: false,
                createdBy: userId,
              },
              select: { id: true, path: true, revision: true, contentHash: true },
            });
            await tx.fileRevision.create({
              data: {
                fileId: created.id,
                revision: 1,
                content: file.content,
                contentHash: file.contentHash,
                isDeleted: false,
                createdBy: userId,
              },
            });
            results.push({ ...created, created: true });
            continue;
          }

          const nextRevision = current.revision + 1;
          const changed = await tx.applicationFile.updateMany({
            where: { id: current.id, revision: current.revision, isDeleted: false },
            data: {
              content: file.content,
              contentHash: file.contentHash,
              language: file.language,
              revision: nextRevision,
              updatedAt: new Date(),
            },
          });
          if (changed.count !== 1) {
            throw new ConflictException(`Source file ${file.path} changed concurrently; no files were applied.`);
          }

          await tx.fileRevision.create({
            data: {
              fileId: current.id,
              revision: nextRevision,
              content: file.content,
              contentHash: file.contentHash,
              isDeleted: false,
              createdBy: userId,
            },
          });
          results.push({
            id: current.id,
            path: file.path,
            revision: nextRevision,
            contentHash: file.contentHash,
            created: false,
          });
        }

        return {
          applicationId,
          filesApplied: results.length,
          files: results,
          atomic: true,
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A generated file conflicted with an existing path; no batch changes were committed.');
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('Source files changed concurrently; no batch changes were committed.');
      }
      throw error;
    }
  }
}
