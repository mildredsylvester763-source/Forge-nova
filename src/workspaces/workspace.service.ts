import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AuthenticatedApiKey } from '../api-keys/api-key.guard';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';

const WORKSPACE_LIST_SELECT = {
  id: true,
  name: true,
  slug: true,
  createdAt: true,
  updatedAt: true,
  organization: { select: { id: true, name: true, slug: true } },
} as const;

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  async listForUser(userId: string) {
    return this.prisma.workspace.findMany({
      where: {
        organization: { memberships: { some: { userId } } },
      },
      select: WORKSPACE_LIST_SELECT,
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Key-authenticated workspace listing, bounded to the key
   * organization. Grounded in the GitHub team listing: organization
   * grouping structures are readable with the organization-level read
   * permission. The row shape mirrors the JWT listing exactly, so the
   * two surfaces can never drift apart. Reads never audit.
   */
  async listForKey(key: AuthenticatedApiKey) {
    return this.prisma.workspace.findMany({
      where: { organizationId: key.organizationId },
      select: WORKSPACE_LIST_SELECT,
      orderBy: { updatedAt: 'desc' },
    });
  }

  async create(userId: string, dto: CreateWorkspaceDto) {
    await this.access.requireOrganizationRole(
      userId,
      dto.organizationId,
      this.access.adminRoles(),
    );
    return this.persistWorkspace(dto);
  }

  /**
   * Key-authenticated workspace create. Grounded in the GitHub team
   * create REST surface: creating an organization grouping structure
   * needs the organization-level write permission, the team is
   * always created inside the organization the token belongs to, and
   * GitHub derives the team slug from the name server-side. Keys are
   * minted only by organization admins, so a WRITE_ORGANIZATION key
   * is an admin-delegated create, and a body organization other
   * than the key organization answers the same uniform 404 the JWT
   * admin gate gives for a foreign organization. There is no audit
   * row because the JWT create writes none.
   */
  async createForKey(key: AuthenticatedApiKey, dto: CreateWorkspaceDto) {
    if (dto.organizationId !== key.organizationId) {
      throw new NotFoundException('Organization not found.');
    }
    return this.persistWorkspace(dto);
  }

  /**
   * Workspace rename. Grounded in the GitHub team update (PATCH
   * /orgs/{org}/teams/{team_slug}): editing a grouping structure is
   * an admin write, and sending the name changes the display label
   * while the slug stays stable, because the slug is the immutable
   * server-derived identifier. The rename writes no audit row
   * because the workspace create surface writes none either.
   */
  async update(userId: string, workspaceId: string, dto: UpdateWorkspaceDto) {
    await this.access.requireWorkspaceRole(userId, workspaceId, this.access.adminRoles());
    return this.applyWorkspaceUpdate(workspaceId, dto);
  }

  /**
   * Key-authenticated workspace rename. Grounded in the GitHub team
   * update behind the Members organization write permission: keys are
   * minted only by organization admins, so a WRITE_ORGANIZATION key
   * is an admin-delegated rename, and a workspace outside the key
   * organization answers the same uniform 404 as an unknown one, so
   * the surface never leaks what exists in other tenants. The slug
   * stays stable and there is no audit row because the JWT rename
   * writes none either.
   */
  async updateForKey(key: AuthenticatedApiKey, workspaceId: string, dto: UpdateWorkspaceDto) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, organizationId: key.organizationId },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found.');
    return this.applyWorkspaceUpdate(workspaceId, dto);
  }

  private async applyWorkspaceUpdate(workspaceId: string, dto: UpdateWorkspaceDto) {
    return this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { name: dto.name.trim() },
      select: {
        id: true,
        organizationId: true,
        name: true,
        slug: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

    private async persistWorkspace(dto: CreateWorkspaceDto) {
    const base = dto.name
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 64) || 'workspace';
    const slug = base + '-' + randomBytes(4).toString('hex');

    try {
      return await this.prisma.workspace.create({
        data: {
          organizationId: dto.organizationId,
          name: dto.name.trim(),
          slug,
        },
        select: {
          id: true,
          organizationId: true,
          name: true,
          slug: true,
          createdAt: true,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A workspace with this identifier already exists.');
      }
      throw error;
    }
  }
}
