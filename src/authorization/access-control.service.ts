import { Injectable, NotFoundException } from '@nestjs/common';
import { MembershipRole, WorkGraphStatus } from '@prisma/client';
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

  async requireApplicationRole(
    userId: string,
    applicationId: string,
    allowedRoles: MembershipRole[],
  ): Promise<{ id: string; projectId: string }> {
    const readOnly = allowedRoles.includes(MembershipRole.VIEWER);
    const application = await this.prisma.application.findFirst({
      where: {
        id: applicationId,
        ...(!readOnly ? { status: { not: 'ARCHIVED' } } : {}),
        project: {
          status: readOnly ? { not: 'DELETED' } : 'ACTIVE',
          workspace: {
            organization: {
              memberships: { some: { userId, role: { in: allowedRoles } } },
            },
          },
        },
      },
      select: { id: true, projectId: true },
    });
    if (!application) throw new NotFoundException('Application not found.');
    return application;
  }

  async requireWorkGraphRole(
    userId: string,
    graphId: string,
    allowedRoles: MembershipRole[],
  ): Promise<{ id: string; applicationId: string; status: WorkGraphStatus; version: number }> {
    const readOnly = allowedRoles.includes(MembershipRole.VIEWER);
    const graph = await this.prisma.workGraph.findFirst({
      where: {
        id: graphId,
        application: {
          ...(!readOnly ? { status: { not: 'ARCHIVED' } } : {}),
          project: {
            status: readOnly ? { not: 'DELETED' } : 'ACTIVE',
            workspace: {
              organization: {
                memberships: { some: { userId, role: { in: allowedRoles } } },
              },
            },
          },
        },
      },
      select: { id: true, applicationId: true, status: true, version: true },
    });
    if (!graph) throw new NotFoundException('Work graph not found.');
    return graph;
  }

  async requireConversationRole(
    userId: string,
    conversationId: string,
    allowedRoles: MembershipRole[],
  ): Promise<{ id: string; applicationId: string; archivedAt: Date | null }> {
    const readOnly = allowedRoles.includes(MembershipRole.VIEWER);
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        application: {
          ...(!readOnly ? { status: { not: 'ARCHIVED' } } : {}),
          project: {
            status: readOnly ? { not: 'DELETED' } : 'ACTIVE',
            workspace: {
              organization: {
                memberships: { some: { userId, role: { in: allowedRoles } } },
              },
            },
          },
        },
      },
      select: { id: true, applicationId: true, archivedAt: true },
    });
    if (!conversation) throw new NotFoundException('Conversation not found.');
    return conversation;
  }

  async requireProjectRole(
    userId: string,
    projectId: string,
    allowedRoles: MembershipRole[],
  ): Promise<{ id: string; workspaceId: string; ownerId: string }> {
    const readOnly = allowedRoles.includes(MembershipRole.VIEWER);
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        status: readOnly ? { not: 'DELETED' } : 'ACTIVE',
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
