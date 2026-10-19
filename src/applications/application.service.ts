import { Injectable, NotFoundException } from '@nestjs/common';
import { ApplicationStatus, MembershipRole } from '@prisma/client';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
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
    return application;
  }

  async update(userId: string, applicationId: string, dto: UpdateApplicationDto) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
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
        actorUserId: userId,
        action: 'application.update',
        resourceType: 'application',
        resourceId: applicationId,
        outcome: 'SUCCESS',
        metadata: { applicationId },
      },
    });
    return application;
  }

  async archive(userId: string, applicationId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    const application = await this.prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.ARCHIVED },
      select: APPLICATION_SELECT,
    });
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'application.archive',
        resourceType: 'application',
        resourceId: applicationId,
        outcome: 'SUCCESS',
        metadata: { applicationId },
      },
    });
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
    const application = await this.prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.PLANNING },
      select: APPLICATION_SELECT,
    });
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'application.restore',
        resourceType: 'application',
        resourceId: applicationId,
        outcome: 'SUCCESS',
        metadata: { applicationId },
      },
    });
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
