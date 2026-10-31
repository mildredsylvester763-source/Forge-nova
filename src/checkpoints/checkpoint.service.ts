import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuthenticatedApiKey } from '../api-keys/api-key.guard';
import {
  WriteActor,
  actorAttribution,
  actorAuditMetadata,
  actorAuditOrganization,
  keyActorFromApiKey,
} from '../api-keys/engine/api-key-policy';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { normalizeApplicationPath } from '../common/source/path-safety';
import { WebhookService } from '../integrations/webhook.service';
import { SecretScannerService } from '../security/secret-scanner.service';

const MAX_CHECKPOINT_FILES = 500;
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_SOURCE_FILE_BYTES = 1_000_000;

const checkpointFileSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1).max(512),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  isDeleted: z.boolean(),
  language: z.string().nullable(),
}).strict();

const checkpointManifestSchema = z.object({
  schemaVersion: z.literal(1),
  application: z.object({
    name: z.string(),
    description: z.string().nullable(),
    framework: z.string().nullable(),
    runtime: z.string().nullable(),
  }).strict(),
  files: z.array(checkpointFileSchema).max(MAX_CHECKPOINT_FILES),
}).strict();

type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;

@Injectable()
export class CheckpointService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly secrets: SecretScannerService,
    private readonly events: WebhookService,
  ) {}

  async create(userId: string, applicationId: string, label: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    return this.createAsActor({ kind: 'user', userId }, applicationId, label);
  }

  /**
   * Key-authenticated checkpoint create. The key is the authorization;
   * the transaction-level tenant bound refuses foreign, missing, and
   * archived applications with the same uniform 404.
   */
  async createForKey(key: AuthenticatedApiKey, applicationId: string, label: string) {
    return this.createAsActor(keyActorFromApiKey(key), applicationId, label);
  }

  private async createAsActor(actor: WriteActor, applicationId: string, label: string) {
    const attributedUserId = actorAttribution(actor);
    const trimmedLabel = label.trim();
    if (!trimmedLabel) throw new BadRequestException('Checkpoint label cannot be blank.');

    try {
      const checkpoint = await this.prisma.$transaction(async (tx) => {
        const application = await this.requireWritableApplication(tx, actor, applicationId);
        const files = await tx.applicationFile.findMany({
          where: { applicationId },
          select: {
            id: true,
            path: true,
            revision: true,
            contentHash: true,
            isDeleted: true,
            language: true,
          },
          orderBy: { path: 'asc' },
          take: MAX_CHECKPOINT_FILES + 1,
        });
        if (files.length > MAX_CHECKPOINT_FILES) {
          throw new BadRequestException(
            `This initial checkpoint implementation supports up to ${MAX_CHECKPOINT_FILES} source files per application.`,
          );
        }

        const manifest: CheckpointManifest = {
          schemaVersion: 1,
          application: {
            name: application.name,
            description: application.description,
            framework: application.framework,
            runtime: application.runtime,
          },
          files,
        };
        if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_MANIFEST_BYTES) {
          throw new BadRequestException('Checkpoint manifest exceeds the 1 MB limit.');
        }

        const checkpoint = await tx.checkpoint.create({
          data: {
            applicationId,
            label: trimmedLabel,
            sourceRef: null,
            manifest: manifest as Prisma.InputJsonValue,
            createdBy: attributedUserId,
          },
          select: { id: true, applicationId: true, label: true, createdAt: true },
        });
        await tx.auditEvent.create({
          data: {
            actorUserId: attributedUserId,
            organizationId: actorAuditOrganization(actor),
            action: 'application.checkpoint.create',
            resourceType: 'checkpoint',
            resourceId: checkpoint.id,
            outcome: 'SUCCESS',
            metadata: actorAuditMetadata(actor, { applicationId, label: trimmedLabel, fileCount: files.length }),
          },
        });
        return { ...checkpoint, fileCount: files.length };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
      await this.events.emitForApplication(applicationId, 'checkpoint.created', {
        applicationId,
        checkpointId: checkpoint.id,
        label: trimmedLabel,
      });
      return checkpoint;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('Application state changed while the checkpoint was being created.');
      }
      throw error;
    }
  }

  async list(userId: string, applicationId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    return this.listForApplication(applicationId);
  }

  /**
   * Key-authenticated checkpoint listing. Reads stay possible on archived
   * applications; foreign and missing applications answer with the
   * same uniform 404.
   */
  async listForKey(key: AuthenticatedApiKey, applicationId: string) {
    await this.access.requireReadableApplicationInOrganization(key.organizationId, applicationId);
    return this.listForApplication(applicationId);
  }

  private async listForApplication(applicationId: string) {
    const checkpoints = await this.prisma.checkpoint.findMany({
      where: { applicationId },
      select: { id: true, label: true, sourceRef: true, createdBy: true, createdAt: true, manifest: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return checkpoints.map((checkpoint) => {
      const parsed = checkpointManifestSchema.safeParse(checkpoint.manifest);
      return {
        id: checkpoint.id,
        label: checkpoint.label,
        sourceRef: checkpoint.sourceRef,
        createdBy: checkpoint.createdBy,
        createdAt: checkpoint.createdAt,
        fileCount: parsed.success ? parsed.data.files.length : null,
      };
    });
  }

  async restore(userId: string, applicationId: string, checkpointId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    return this.restoreAsActor({ kind: 'user', userId }, applicationId, checkpointId);
  }

  /**
   * Key-authenticated checkpoint restore with the same idempotency and
   * race semantics as the JWT surface: a double-tap replay changes
   * nothing, and the loser of a restore-vs-write race rolls back cleanly.
   */
  async restoreForKey(key: AuthenticatedApiKey, applicationId: string, checkpointId: string) {
    return this.restoreAsActor(keyActorFromApiKey(key), applicationId, checkpointId);
  }

  private async restoreAsActor(actor: WriteActor, applicationId: string, checkpointId: string) {
    const attributedUserId = actorAttribution(actor);
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const application = await this.requireWritableApplication(tx, actor, applicationId);
        const checkpoint = await tx.checkpoint.findFirst({
          where: { id: checkpointId, applicationId },
          select: { id: true, label: true, manifest: true },
        });
        if (!checkpoint) throw new NotFoundException('Checkpoint not found.');

        const parsed = checkpointManifestSchema.safeParse(checkpoint.manifest);
        if (!parsed.success) {
          throw new ConflictException('Checkpoint manifest is invalid or uses an unsupported schema version.');
        }
        const manifest = parsed.data;
        const ids = manifest.files.map((file) => file.id);
        const paths = manifest.files.map((file) => file.path);
        if (new Set(ids).size !== ids.length || new Set(paths).size !== paths.length) {
          throw new ConflictException('Checkpoint manifest contains duplicate file identities or paths.');
        }
        for (const file of manifest.files) {
          if (normalizeApplicationPath(file.path) !== file.path) {
            throw new ConflictException('Checkpoint manifest contains an unsafe or non-canonical file path.');
          }
        }
        const currentFiles = await tx.applicationFile.findMany({
          where: { applicationId },
          orderBy: { path: 'asc' },
        });
        if (currentFiles.length > MAX_CHECKPOINT_FILES) {
          throw new ConflictException('Application exceeds the initial checkpoint restore file limit; no changes were applied.');
        }
        const currentById = new Map(currentFiles.map((file) => [file.id, file]));
        const snapshotIds = new Set(manifest.files.map((file) => file.id));
        let changedFiles = 0;

        for (const snapshotFile of manifest.files) {
          const current = currentById.get(snapshotFile.id);
          if (!current || current.path !== snapshotFile.path) {
            throw new ConflictException(
              `Checkpoint source file ${snapshotFile.path} is missing or has changed identity; restore was rolled back.`,
            );
          }

          const revision = await tx.fileRevision.findFirst({
            where: {
              fileId: snapshotFile.id,
              revision: snapshotFile.revision,
              contentHash: snapshotFile.contentHash,
              isDeleted: snapshotFile.isDeleted,
            },
          });
          if (!revision) {
            throw new ConflictException(
              `The immutable revision for ${snapshotFile.path} is unavailable; restore was rolled back.`,
            );
          }
          // Idempotency law: compare CONTENT and file state, not revision numbers.
          // A restore replays the same immutable content, so after one restore the
          // live revision number is higher than the snapshot while the content is
          // identical. Comparing revisions made every replay (including the loser
          // of a double-tap race) rewrite the file as a pointless duplicate revision.
          if (
            current.contentHash === snapshotFile.contentHash &&
            current.isDeleted === snapshotFile.isDeleted &&
            current.language === snapshotFile.language
          ) {
            continue;
          }

          if (Buffer.byteLength(revision.content, 'utf8') > MAX_SOURCE_FILE_BYTES) {
            throw new ConflictException(`Checkpoint file ${snapshotFile.path} exceeds the source file limit.`);
          }
          this.secrets.assertNoSecrets(revision.content);
          const nextRevision = current.revision + 1;
          const updated = await tx.applicationFile.updateMany({
            where: { id: current.id, revision: current.revision },
            data: {
              content: revision.content,
              contentHash: revision.contentHash,
              language: snapshotFile.language,
              revision: nextRevision,
              isDeleted: snapshotFile.isDeleted,
              updatedAt: new Date(),
            },
          });
          if (updated.count !== 1) {
            throw new ConflictException('A source file changed concurrently; the checkpoint restore was rolled back.');
          }
          await tx.fileRevision.create({
            data: {
              fileId: current.id,
              revision: nextRevision,
              content: revision.content,
              contentHash: revision.contentHash,
              isDeleted: snapshotFile.isDeleted,
              createdBy: attributedUserId,
            },
          });
          changedFiles += 1;
        }

        for (const current of currentFiles) {
          if (snapshotIds.has(current.id) || current.isDeleted) continue;
          const nextRevision = current.revision + 1;
          const updated = await tx.applicationFile.updateMany({
            where: { id: current.id, revision: current.revision, isDeleted: false },
            data: { revision: nextRevision, isDeleted: true, updatedAt: new Date() },
          });
          if (updated.count !== 1) {
            throw new ConflictException('A newly created source file changed concurrently; restore was rolled back.');
          }
          await tx.fileRevision.create({
            data: {
              fileId: current.id,
              revision: nextRevision,
              content: current.content,
              contentHash: current.contentHash,
              isDeleted: true,
              createdBy: attributedUserId,
            },
          });
          changedFiles += 1;
        }

        await tx.application.update({
          where: { id: applicationId },
          data: {
            name: manifest.application.name,
            description: manifest.application.description,
            framework: manifest.application.framework,
            runtime: manifest.application.runtime,
          },
        });
        await tx.auditEvent.create({
          data: {
            actorUserId: attributedUserId,
            organizationId: actorAuditOrganization(actor),
            action: 'application.checkpoint.restore',
            resourceType: 'checkpoint',
            resourceId: checkpoint.id,
            outcome: 'SUCCESS',
            metadata: actorAuditMetadata(actor, { applicationId, label: checkpoint.label, changedFiles }),
          },
        });
        return {
          applicationId,
          checkpointId: checkpoint.id,
          label: checkpoint.label,
          changedFiles,
          atomic: true,
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
      await this.events.emitForApplication(applicationId, 'checkpoint.restored', {
        applicationId,
        checkpointId: result.checkpointId,
        changedFiles: result.changedFiles,
      });
      return result;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('Application state changed concurrently; checkpoint restore was rolled back.');
      }
      throw error;
    }
  }

  private async requireWritableApplication(
    tx: Prisma.TransactionClient,
    actor: WriteActor,
    applicationId: string,
  ) {
    const application = await tx.application.findFirst({
      where: {
        id: applicationId,
        status: { not: 'ARCHIVED' },
        project: { status: 'ACTIVE' },
      },
      select: {
        id: true,
        name: true,
        description: true,
        framework: true,
        runtime: true,
        project: { select: { workspace: { select: { organizationId: true } } } },
      },
    });
    if (actor.kind === 'apiKey') {
      // The key is the authorization: the tenant bound is the organization.
      // Foreign, missing, and archived applications are all one uniform 404.
      if (!application || application.project.workspace.organizationId !== actor.organizationId) {
        throw new NotFoundException('Application not found.');
      }
      return application;
    }
    if (!application) throw new ForbiddenException('The application is not writable.');
    const membership = await tx.membership.findFirst({
      where: {
        userId: actor.userId,
        organizationId: application.project.workspace.organizationId,
        role: { in: this.access.writeRoles() },
      },
      select: { id: true },
    });
    if (!membership) throw new ForbiddenException('Write access was revoked before checkpoint operation.');
    return application;
  }
}
