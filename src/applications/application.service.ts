import { Injectable } from '@nestjs/common';
import { ApplicationStatus } from '@prisma/client';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { CreateApplicationDto } from './dto/create-application.dto';

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
      select: {
        id: true,
        projectId: true,
        name: true,
        description: true,
        status: true,
        framework: true,
        runtime: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async create(userId: string, projectId: string, dto: CreateApplicationDto) {
    await this.access.requireProjectRole(userId, projectId, this.access.writeRoles());
    return this.prisma.application.create({
      data: {
        projectId,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        framework: dto.framework?.trim() || null,
        runtime: dto.runtime?.trim() || null,
      },
      select: {
        id: true,
        projectId: true,
        name: true,
        description: true,
        status: true,
        framework: true,
        runtime: true,
        createdAt: true,
      },
    });
  }
}
