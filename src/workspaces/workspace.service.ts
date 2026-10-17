import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';

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
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        updatedAt: true,
        organization: { select: { id: true, name: true, slug: true } },
      },
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
    const slug = `${base}-${Math.random().toString(36).slice(2, 8)}`;

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
