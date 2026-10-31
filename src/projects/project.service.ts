import { Injectable, NotFoundException } from '@nestjs/common';
import { MembershipRole, ProjectStatus } from '@prisma/client';
import { AuthenticatedApiKey } from '../api-keys/api-key.guard';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

const PROJECT_LIST_SELECT = {
  id: true,
  workspaceId: true,
  ownerId: true,
  name: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { applications: true } },
} as const;

const PROJECT_DETAIL_SELECT = {
  id: true,
  workspaceId: true,
  ownerId: true,
  name: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  applications: {
    select: { id: true, name: true, status: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  },
} as const;

@Injectable()
export class ProjectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  async listInWorkspace(userId: string, workspaceId: string) {
    await this.access.requireWorkspaceRole(userId, workspaceId, this.access.allRoles());
    return this.prisma.project.findMany({
      where: { workspaceId, status: { not: 'DELETED' } },
      select: PROJECT_LIST_SELECT,
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Key-authenticated project listing inside one workspace. Grounded in
   * the GitHub project listing: the Projects read permission is enough.
   * The workspace must belong to the key organization, so foreign and
   * missing workspaces answer one uniform 404 that never leaks what
   * exists. The rows mirror the JWT listing exactly and reads never
   * audit.
   */
  async listInWorkspaceForKey(key: AuthenticatedApiKey, workspaceId: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, organizationId: key.organizationId },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found.');
    return this.prisma.project.findMany({
      where: { workspaceId, status: { not: 'DELETED' } },
      select: PROJECT_LIST_SELECT,
      orderBy: { updatedAt: 'desc' },
    });
  }

  async create(userId: string, workspaceId: string, dto: CreateProjectDto) {
    await this.access.requireWorkspaceRole(userId, workspaceId, this.access.writeRoles());
    return this.prisma.project.create({
      data: {
        workspaceId,
        ownerId: userId,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
      },
      select: {
        id: true,
        workspaceId: true,
        ownerId: true,
        name: true,
        description: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async get(userId: string, projectId: string) {
    await this.access.requireProjectRole(userId, projectId, this.access.allRoles());
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: PROJECT_DETAIL_SELECT,
    });
    if (!project) throw new NotFoundException('Project not found.');
    return project;
  }

  /**
   * Key-authenticated project inspection. Grounded in the GitHub
   * single-project read: the Projects read permission is enough and the
   * shape mirrors the JWT inspection exactly, nested applications
   * included. The project must live in the key organization and not be
   * deleted, so foreign, unknown, and deleted projects answer one
   * uniform 404. Reads never audit.
   */
  async getForKey(key: AuthenticatedApiKey, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        status: { not: 'DELETED' },
        workspace: { organizationId: key.organizationId },
      },
      select: PROJECT_DETAIL_SELECT,
    });
    if (!project) throw new NotFoundException('Project not found.');
    return project;
  }

  async update(userId: string, projectId: string, dto: UpdateProjectDto) {
    await this.access.requireProjectRole(userId, projectId, this.access.writeRoles());
    return this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
      },
      select: {
        id: true,
        workspaceId: true,
        ownerId: true,
        name: true,
        description: true,
        status: true,
        updatedAt: true,
      },
    });
  }

  async archive(userId: string, projectId: string) {
    await this.access.requireProjectRole(userId, projectId, this.access.writeRoles());
    return this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.ARCHIVED },
      select: { id: true, name: true, status: true, updatedAt: true },
    });
  }

  /**
   * Restores an archived project. The archived-state lookup below is the guard
   * itself: write-role access checks exclude ARCHIVED projects.
   */
  async restore(userId: string, projectId: string) {
    const archived = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        status: ProjectStatus.ARCHIVED,
        workspace: {
          organization: {
            memberships: { some: { userId, role: { in: this.access.writeRoles() } } },
          },
        },
      },
      select: { id: true },
    });
    if (!archived) {
      throw new NotFoundException('Archived project not found.');
    }
    const restored = await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.ACTIVE },
      select: { id: true, workspaceId: true, name: true, status: true, updatedAt: true },
    });
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'project.restore',
        resourceType: 'project',
        resourceId: projectId,
        outcome: 'SUCCESS',
        metadata: { projectId },
      },
    });
    return restored;
  }
}
