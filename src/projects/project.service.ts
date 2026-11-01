import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { MembershipRole, ProjectStatus } from '@prisma/client';
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
    return this.persistProject(workspaceId, userId, dto);
  }

  /**
   * Key-authenticated project create. Grounded in the GitHub Projects
   * REST surface, where creating an organization project needs the
   * Projects write permission: the workspace must belong to the key
   * organization, so foreign and missing workspaces answer one uniform
   * 404. GitHub ties tokens to the user who generated them, and the
   * project row demands a real owner (the schema restricts owner
   * deletion), so a key whose creator no longer exists answers a named
   * refusal instead of a fake owner or a raw foreign-key 500. The
   * created row mirrors the JWT create exactly and the create writes
   * no audit row because the JWT create writes none either.
   */
  async createForKey(key: AuthenticatedApiKey, workspaceId: string, dto: CreateProjectDto) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, organizationId: key.organizationId },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found.');
    const ownerId = key.createdBy;
    if (ownerId !== null) {
      const owner = await this.prisma.user.findUnique({
        where: { id: ownerId },
        select: { id: true },
      });
      if (owner) {
        return this.persistProject(workspaceId, ownerId, dto);
      }
    }
    throw new ConflictException('The key creator no longer exists.');
  }

  private async persistProject(workspaceId: string, ownerId: string, dto: CreateProjectDto) {
    return this.prisma.project.create({
      data: {
        workspaceId,
        ownerId,
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
    return this.applyProjectUpdate(projectId, dto);
  }

  /**
   * Key-authenticated project partial update. Grounded in the GitHub
   * project update: the Projects write permission governs metadata
   * writes, only the fields sent change, and the writable tenant bound
   * refuses foreign, missing, and archived projects with one uniform
   * 404 exactly like the JWT write-role guard. The response mirrors the
   * JWT update and the update writes no audit row because the JWT
   * update writes none either.
   */
  async updateForKey(key: AuthenticatedApiKey, projectId: string, dto: UpdateProjectDto) {
    await this.access.requireProjectInOrganization(key.organizationId, projectId);
    return this.applyProjectUpdate(projectId, dto);
  }

  private async applyProjectUpdate(projectId: string, dto: UpdateProjectDto) {
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
    return this.applyProjectArchive(projectId);
  }

  /**
   * Key-authenticated project archive. Grounded in the GitHub project
   * state update (open and closed): the Projects write permission
   * governs the state change, the writable tenant bound refuses
   * foreign, missing, and already archived projects with one uniform
   * 404 exactly like the JWT write-role guard, and the response mirrors
   * the JWT archive. The archive writes no audit row because the JWT
   * archive writes none either.
   */
  async archiveForKey(key: AuthenticatedApiKey, projectId: string) {
    await this.access.requireProjectInOrganization(key.organizationId, projectId);
    return this.applyProjectArchive(projectId);
  }

  private async applyProjectArchive(projectId: string) {
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
    return this.restoreArchivedProject({ kind: 'user', userId }, projectId);
  }

  /**
   * Key-authenticated project restore. Grounded in the GitHub project
   * reopen (the state flips back through the write surface): the
   * archived project must live in the key organization, so foreign,
   * unknown, and active projects answer one uniform 404 exactly like
   * the JWT restore guard, and the landed restore writes exactly one
   * attributed audit row stamped via genapi with the acting key.
   */
  async restoreForKey(key: AuthenticatedApiKey, projectId: string) {
    const archived = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        status: ProjectStatus.ARCHIVED,
        workspace: { organizationId: key.organizationId },
      },
      select: { id: true },
    });
    if (!archived) {
      throw new NotFoundException('Archived project not found.');
    }
    return this.restoreArchivedProject(keyActorFromApiKey(key), projectId);
  }

  /**
   * The restore claim is atomic: the status flip is a conditional
   * updateMany, so a double-tapped restore or two racing restores end
   * exactly one way (one 201 with its one audit row and one clean 404)
   * instead of two landed restores.
   */
  private async restoreArchivedProject(actor: WriteActor, projectId: string) {
    const claimed = await this.prisma.project.updateMany({
      where: { id: projectId, status: ProjectStatus.ARCHIVED },
      data: { status: ProjectStatus.ACTIVE },
    });
    if (claimed.count === 0) {
      throw new NotFoundException('Archived project not found.');
    }
    const restored = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, workspaceId: true, name: true, status: true, updatedAt: true },
    });
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: actorAttribution(actor),
        organizationId: actorAuditOrganization(actor),
        action: 'project.restore',
        resourceType: 'project',
        resourceId: projectId,
        outcome: 'SUCCESS',
        metadata: actorAuditMetadata(actor, { projectId }),
      },
    });
    return restored!;
  }
}
