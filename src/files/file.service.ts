import {
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AccessControlService } from '../authorization/access-control.service';
import { normalizeApplicationPath } from '../common/source/path-safety';
import { PrismaService } from '../database/prisma.service';
import { SecretScannerService } from '../security/secret-scanner.service';
import { WriteFileDto } from './dto/write-file.dto';

const MAX_FILE_BYTES = 1_000_000;

@Injectable()
export class FileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly secrets: SecretScannerService,
  ) {}

  async list(userId: string, applicationId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    return this.prisma.applicationFile.findMany({
      where: { applicationId, isDeleted: false },
      select: {
        id: true,
        applicationId: true,
        path: true,
        language: true,
        contentHash: true,
        revision: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { path: 'asc' },
    });
  }

  async read(userId: string, applicationId: string, fileId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    const file = await this.prisma.applicationFile.findFirst({
      where: { id: fileId, applicationId, isDeleted: false },
      select: {
        id: true,
        applicationId: true,
        path: true,
        language: true,
        content: true,
        contentHash: true,
        revision: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!file) throw new NotFoundException('Application file not found.');
    return file;
  }

  async write(userId: string, applicationId: string, dto: WriteFileDto) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    const path = normalizeApplicationPath(dto.path);
    const content = dto.content;
    this.secrets.assertNoSecrets(content);
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw new PayloadTooLargeException('A source file cannot exceed 1 MB in UTF-8.');
    }
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');

    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await tx.applicationFile.findUnique({
          where: { applicationId_path: { applicationId, path } },
        });

        if (!current) {
          if (dto.expectedRevision !== undefined) {
            throw new ConflictException('The file does not exist; omit expectedRevision when creating it.');
          }
          const created = await tx.applicationFile.create({
            data: {
              applicationId,
              path,
              language: dto.language?.trim() || null,
              content,
              contentHash,
              revision: 1,
              isDeleted: false,
              createdBy: userId,
            },
          });
          await tx.fileRevision.create({
            data: {
              fileId: created.id,
              revision: 1,
              content,
              contentHash,
              isDeleted: false,
              createdBy: userId,
            },
          });
          return this.safeFile(created);
        }

        if (dto.expectedRevision === undefined) {
          throw new ConflictException('expectedRevision is required when updating an existing file.');
        }
        if (dto.expectedRevision !== current.revision) {
          throw new ConflictException({
            message: 'The file changed since it was read.',
            expectedRevision: dto.expectedRevision,
            currentRevision: current.revision,
          });
        }

        const nextRevision = current.revision + 1;
        const changed = await tx.applicationFile.updateMany({
          where: { id: current.id, revision: current.revision },
          data: {
            content,
            contentHash,
            language: dto.language?.trim() || null,
            revision: nextRevision,
            isDeleted: false,
            updatedAt: new Date(),
          },
        });
        if (changed.count !== 1) {
          throw new ConflictException('The file changed concurrently; read it again before retrying.');
        }

        await tx.fileRevision.create({
          data: {
            fileId: current.id,
            revision: nextRevision,
            content,
            contentHash,
            isDeleted: false,
            createdBy: userId,
          },
        });

        const updated = await tx.applicationFile.findUniqueOrThrow({
          where: { id: current.id },
        });
        return this.safeFile(updated);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A file with this path already exists.');
      }
      throw error;
    }
  }

  async revisions(userId: string, applicationId: string, fileId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    const file = await this.prisma.applicationFile.findFirst({
      where: { id: fileId, applicationId },
      select: { id: true },
    });
    if (!file) throw new NotFoundException('Application file not found.');
    return this.prisma.fileRevision.findMany({
      where: { fileId },
      select: {
        id: true,
        revision: true,
        contentHash: true,
        isDeleted: true,
        createdBy: true,
        createdAt: true,
      },
      orderBy: { revision: 'desc' },
    });
  }

  async delete(userId: string, applicationId: string, fileId: string, expectedRevision: number) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.applicationFile.findFirst({
        where: { id: fileId, applicationId, isDeleted: false },
      });
      if (!current) throw new NotFoundException('Application file not found.');
      if (current.revision !== expectedRevision) {
        throw new ConflictException({
          message: 'The file changed since it was read.',
          expectedRevision,
          currentRevision: current.revision,
        });
      }

      const nextRevision = current.revision + 1;
      const changed = await tx.applicationFile.updateMany({
        where: { id: current.id, revision: current.revision, isDeleted: false },
        data: { revision: nextRevision, isDeleted: true, updatedAt: new Date() },
      });
      if (changed.count !== 1) {
        throw new ConflictException('The file changed concurrently; read it again before retrying.');
      }

      await tx.fileRevision.create({
        data: {
          fileId: current.id,
          revision: nextRevision,
          content: current.content,
          contentHash: current.contentHash,
          isDeleted: true,
          createdBy: userId,
        },
      });
      return { id: current.id, path: current.path, revision: nextRevision, deleted: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private safeFile<T extends { content: string }>(file: T) {
    return file;
  }
}
