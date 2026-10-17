import { Injectable, NotFoundException } from '@nestjs/common';
import { MembershipRole } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class AccessControlService {
  constructor(private readonly prisma: PrismaService) {}

  async requireOrganizationRole(
    userId: string,
    organizationId: string,
    allowedRoles: MembershipRole[],
  ): Promise<{ id: string }> {
    const organization = await this.prisma.organization.findFirst({
      where: {
        id: organizationId,
        memberships: { some: { userId, role: { in: allowedRoles } } },
      },
      select: { id: true },
    });
    if (!organization) throw new NotFoundException('Organization not found.');
    return organization;
  }

  async requireWorkspaceRole(
    userId: string,
    workspaceId: string,
    allowedRoles: MembershipRole[],
  ): Promise<{ id: string; organizationId: string }> {
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        organization: {
          memberships: { some: { userId, role: { in: allowedRoles } } },
        },
      },
      select: { id: true, organizationId: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found.');
    return workspace;
  }

  async requireProjectRole(
    userId: string,
    projectId: string,
    allowedRoles: MembershipRole[],
  ): Promise<{ id: string; workspaceId: string; ownerId: string }> {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        status: { not: 'DELETED' },
        workspace: {
          organization: {
            memberships: { some: { userId, role: { in: allowedRoles } } },
          },
        },
      },
      select: { id: true, workspaceId: true, ownerId: true },
    });
    if (!project) throw new NotFoundException('Project not found.');
    return project;
  }

  allRoles(): MembershipRole[] {
    return ['OWNER', 'ADMIN', 'DEVELOPER', 'BILLING', 'VIEWER'];
  }

  writeRoles(): MembershipRole[] {
    return ['OWNER', 'ADMIN', 'DEVELOPER'];
  }

  adminRoles(): MembershipRole[] {
    return ['OWNER', 'ADMIN'];
  }
}
