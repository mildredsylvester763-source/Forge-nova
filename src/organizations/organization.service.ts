import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MembershipRole, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { AddMemberDto } from './dto/add-member.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';

@Injectable()
export class OrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  listForUser(userId: string) {
    return this.prisma.organization.findMany({
      where: { memberships: { some: { userId } } },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        memberships: {
          where: { userId },
          select: { role: true },
        },
        _count: { select: { memberships: true, workspaces: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(userId: string, dto: CreateOrganizationDto) {
    const baseSlug = dto.name
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 48) || 'organization';
    const slug = `${baseSlug}-${randomBytes(4).toString('hex')}`;

    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: dto.name.trim(),
          slug,
          memberships: {
            create: {
              role: MembershipRole.OWNER,
              user: { connect: { id: userId } },
            },
          },
          workspaces: {
            create: { name: 'General', slug: 'general' },
          },
        },
        select: {
          id: true,
          name: true,
          slug: true,
          createdAt: true,
          workspaces: { select: { id: true, name: true, slug: true } },
        },
      });

      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          organizationId: organization.id,
          action: 'organization.create',
          resourceType: 'organization',
          resourceId: organization.id,
          outcome: 'SUCCESS',
        },
      });
      return organization;
    });
  }

  async listMembers(userId: string, organizationId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.allRoles());
    return this.prisma.membership.findMany({
      where: { organizationId },
      select: {
        id: true,
        role: true,
        createdAt: true,
        user: { select: { id: true, email: true, displayName: true, status: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addMember(userId: string, organizationId: string, dto: AddMemberDto) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    if (dto.role === MembershipRole.OWNER) {
      throw new BadRequestException('Owner assignment requires the dedicated ownership-transfer workflow.');
    }

    const email = dto.email.trim().toLowerCase();
    const target = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, status: true },
    });
    if (!target || target.status !== 'ACTIVE') {
      throw new NotFoundException('An active GENESIS account with this email was not found.');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const membership = await tx.membership.create({
          data: { organizationId, userId: target.id, role: dto.role },
          select: {
            id: true,
            organizationId: true,
            role: true,
            createdAt: true,
            user: { select: { id: true, email: true, displayName: true } },
          },
        });

        await tx.auditEvent.create({
          data: {
            actorUserId: userId,
            organizationId,
            action: 'organization.member.add',
            resourceType: 'membership',
            resourceId: membership.id,
            outcome: 'SUCCESS',
            metadata: { role: dto.role },
          },
        });
        return membership;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('This account is already a member of the organization.');
      }
      throw error;
    }
  }
}
