import { Injectable, NotFoundException } from '@nestjs/common';
import { ApplicationStatus, MembershipRole } from '@prisma/client';
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
import { WebhookService } from '../integrations/webhook.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';

const APPLICATION_SELECT = {
  id: true,
  projectId: true,
  name: true,
  description: true,
  status: true,
  framework: true,
  runtime: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ApplicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly events: WebhookService,
  ) {}

  async listForProject(userId: string, projectId: string) {
    await this.access.requireProjectRole(userId, projectId, this.access.allRoles());
    return this.prisma.application.findMany({
      where: { projectId, status: { not: ApplicationStatus.ARCHIVED } },
      select: APPLICATION_SELECT,
      orderBy: { updatedAt: 'desc' },
    });
  }

  async create(userId: string, projectId: string, dto: CreateApplicationDto) {
    await this.access.requireProjectRole(userId, projectId, this.access.writeRoles());
    const application = await this.prisma.application.create({
      data: {
        projectId,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        framework: dto.framework?.trim() || null,
        runtime: dto.runtime?.trim() || null,
      },
      select: APPLICATION_SELECT,
    });
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'application.create',
        resourceType: 'application',
        resourceId: application.id,
        outcome: 'SUCCESS',
        metadata: { applicationId: application.id, projectId },
      },
    });
    await this.events.emitForProject(projectId, 'application.created', {
      applicationId: application.id,
      name: application.name,
    });
    return application;
  }

  async update(userId: string, applicationId: string, dto: UpdateApplicationDto) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    return this.updateAsActor({ kind: 'user', userId }, applicationId, dto);
  }

  /**
   * Key-authenticated update. The writable tenant bound is the guard:
   * foreign, missing, and archived applications all answer the same
   * uniform 404, so an update can neither probe other tenants nor
   * touch an archived application. Grounded in the market leaders:
   * GitHub repository updates and Vercel project updates are partial
   * metadata writes by id behind write permission, never read.
   */
  async updateForKey(key: AuthenticatedApiKey, applicationId: string, dto: UpdateApplicationDto) {
    await this.access.requireApplicationInOrganization(key.organizationId, applicationId);
    return this.updateAsActor(keyActorFromApiKey(key), applicationId, dto);
  }

  private async updateAsActor(
    actor: WriteActor,
    applicationId: string,
    dto: UpdateApplicationDto,
  ) {
    const attributedUserId = actorAttribution(actor);
    const application = await this.prisma.application.update({
      where: { id: applicationId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
        ...(dto.framework !== undefined ? { framework: dto.framework.trim() || null } : {}),
        ...(dto.runtime !== undefined ? { runtime: dto.runtime.trim() || null } : {}),
      },
      select: APPLICATION_SELECT,
    });
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: attributedUserId,
        organizationId: actorAuditOrganization(actor),
        action: 'application.update',
        resourceType: 'application',
        resourceId: applicationId,
        outcome: 'SUCCESS',
        metadata: actorAuditMetadata(actor, { applicationId }),
      },
    });
    await this.events.emitForApplication(applicationId, 'application.updated', { applicationId });
    return application;
  }

  async archive(userId: string, applicationId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    return this.archiveAsActor({ kind: 'user', userId }, applicationId);
  }

  /**
   * Key-authenticated archive. The key is the authorization: the tenant
   * bound refuses foreign, missing, and already archived applications
   * with the same uniform 404, so an archive double-tap answers 404 the
   * second time exactly like the JWT surface.
   */
  async archiveForKey(key: AuthenticatedApiKey, applicationId: string) {
    await this.access.requireApplicationInOrganization(key.organizationId, applicationId);
    return this.archiveAsActor(keyActorFromApiKey(key), applicationId);
  }

  private async archiveAsActor(actor: WriteActor, applicationId: string) {
    const attributedUserId = actorAttribution(actor);
    const application = await this.prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.ARCHIVED },
      select: APPLICATION_SELECT,
    });
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: attributedUserId,
        organizationId: actorAuditOrganization(actor),
        action: 'application.archive',
        resourceType: 'application',
        resourceId: applicationId,
        outcome: 'SUCCESS',
        metadata: actorAuditMetadata(actor, { applicationId }),
      },
    });
    await this.events.emitForApplication(applicationId, 'application.archived', { applicationId });
    return application;
  }

  /**
   * Restores an archived application. This intentionally does not go through
   * requireApplicationRole (write roles exclude archived applications); the
   * archived-state lookup below is the guard itself.
   */
  async restore(userId: string, applicationId: string) {
    const archived = await this.findArchivedForWriter(userId, applicationId);
    if (!archived) {
      throw new NotFoundException('Archived application not found.');
    }
    return this.restoreAsActor({ kind: 'user', userId }, applicationId);
  }

  /**
   * Key-authenticated restore. The archived-state lookup bounded to the
   * key organization is the guard itself, exactly like the JWT surface:
   * foreign, missing, and non-archived applications all answer the
   * same uniform 404.
   */
  async restoreForKey(key: AuthenticatedApiKey, applicationId: string) {
    const actor = keyActorFromApiKey(key);
    const archived = await this.prisma.application.findFirst({
      where: {
        id: applicationId,
        status: ApplicationStatus.ARCHIVED,
        project: {
          status: 'ACTIVE',
          workspace: { organizationId: actor.organizationId },
        },
      },
      select: { id: true },
    });
    if (!archived) {
      throw new NotFoundException('Archived application not found.');
    }
    return this.restoreAsActor(actor, applicationId);
  }

  private async restoreAsActor(actor: WriteActor, applicationId: string) {
    const attributedUserId = actorAttribution(actor);
    const application = await this.prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.PLANNING },
      select: APPLICATION_SELECT,
    });
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: attributedUserId,
        organizationId: actorAuditOrganization(actor),
        action: 'application.restore',
        resourceType: 'application',
        resourceId: applicationId,
        outcome: 'SUCCESS',
        metadata: actorAuditMetadata(actor, { applicationId }),
      },
    });
    await this.events.emitForApplication(applicationId, 'application.updated', { applicationId });
    return application;
  }

  private findArchivedForWriter(userId: string, applicationId: string) {
    const writeRoles: MembershipRole[] = this.access.writeRoles();
    return this.prisma.application.findFirst({
      where: {
        id: applicationId,
        status: ApplicationStatus.ARCHIVED,
        project: {
          status: 'ACTIVE',
          workspace: {
            organization: {
              memberships: { some: { userId, role: { in: writeRoles } } },
            },
          },
        },
      },
      select: { id: true },
    });
  }
}
