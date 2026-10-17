import { Injectable, NotFoundException } from '@nestjs/common';
import { MembershipRole, ProjectStatus } from '@prisma/client';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

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
      select: {
        id: true,
        workspaceId: true,
        ownerId: true,
        name: true,
        description: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { applications: true } },
      },
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
      select: {
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
      },
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
}
