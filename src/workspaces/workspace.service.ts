import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AuthenticatedApiKey } from '../api-keys/api-key.guard';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';

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
    const base = dto.name
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 64) || 'workspace';
    const slug = `${base}-${randomBytes(4).toString('hex')}`;

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
