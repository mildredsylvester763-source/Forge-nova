import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MembershipRole, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { AddMemberDto } from './dto/add-member.dto';
import { ChangeMemberRoleDto } from './dto/change-member-role.dto';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto';
import { canChangeMemberRole, canRemoveMember, MembershipPolicyRefusal } from './engine/membership-policy.engine';
import { CreateOrganizationDto } from './dto/create-organization.dto';

const REFUSAL_MESSAGES: Record<MembershipPolicyRefusal, string> = {
  'membership.owner-assignment-requires-transfer':
    'Owner assignment requires the dedicated ownership-transfer workflow.',
  'membership.last-owner-protected':
    'The organization must keep at least one owner.',
  'membership.owner-removal-requires-transfer':
    'Owners cannot be removed directly. Transfer ownership first.',
};

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

  async changeMemberRole(
    userId: string,
    organizationId: string,
    membershipId: string,
    dto: ChangeMemberRoleDto,
  ) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    const membership = await this.prisma.membership.findUnique({
      where: { id: membershipId },
      select: { id: true, userId: true, role: true, organizationId: true },
    });
    if (!membership || membership.organizationId !== organizationId) {
      throw new NotFoundException('Membership not found.');
    }
    const ownerCount = await this.prisma.membership.count({
      where: { organizationId, role: MembershipRole.OWNER },
    });
    const decision = canChangeMemberRole(membership.role, dto.role, ownerCount);
    if (!decision.allowed) {
      throw new BadRequestException(REFUSAL_MESSAGES[decision.refusal]);
    }
    const updated = await this.prisma.membership.update({
      where: { id: membershipId },
      data: { role: dto.role },
      select: {
        id: true,
        organizationId: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, email: true, displayName: true } },
      },
    });
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        organizationId,
        action: 'organization.member.role.change',
        resourceType: 'membership',
        resourceId: membershipId,
        outcome: 'SUCCESS',
        metadata: { previousRole: membership.role, newRole: dto.role },
      },
    });
    return updated;
  }

  async removeMember(userId: string, organizationId: string, membershipId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    const membership = await this.prisma.membership.findUnique({
      where: { id: membershipId },
      select: { id: true, userId: true, role: true, organizationId: true },
    });
    if (!membership || membership.organizationId !== organizationId) {
      throw new NotFoundException('Membership not found.');
    }
    const decision = canRemoveMember(membership.role);
    if (!decision.allowed) {
      throw new BadRequestException(REFUSAL_MESSAGES[decision.refusal]);
    }
    await this.prisma.membership.delete({ where: { id: membershipId } });
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        organizationId,
        action: 'organization.member.remove',
        resourceType: 'membership',
        resourceId: membershipId,
        outcome: 'SUCCESS',
        metadata: { removedUserId: membership.userId, role: membership.role },
      },
    });
    return { removed: true, membershipId };
  }

  async transferOwnership(userId: string, organizationId: string, dto: TransferOwnershipDto) {
    const actor = await this.prisma.membership.findFirst({
      where: { userId, organizationId, role: MembershipRole.OWNER },
      select: { id: true },
    });
    if (!actor) {
      throw new ForbiddenException('Only an owner can transfer ownership.');
    }

    return this.prisma.$transaction(async (tx) => {
      const target = await tx.membership.findUnique({
        where: { id: dto.memberId },
        select: { id: true, userId: true, organizationId: true },
      });
      if (!target || target.organizationId !== organizationId) {
        throw new NotFoundException('Target membership not found.');
      }
      if (target.userId === userId) {
        throw new BadRequestException('You already own this organization.');
      }
      await tx.membership.update({ where: { id: target.id }, data: { role: MembershipRole.OWNER } });
      await tx.membership.update({ where: { id: actor.id }, data: { role: MembershipRole.ADMIN } });
      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          organizationId,
          action: 'organization.ownership.transfer',
          resourceType: 'membership',
          resourceId: target.id,
          outcome: 'SUCCESS',
          metadata: { previousOwnerId: userId, newOwnerId: target.userId },
        },
      });
      return {
        organizationId,
        previousOwnerId: userId,
        newOwnerId: target.userId,
      };
    });
  }

  async listAuditEvents(userId: string, organizationId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    return this.prisma.auditEvent.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        action: true,
        resourceType: true,
        resourceId: true,
        outcome: true,
        metadata: true,
        createdAt: true,
        actor: { select: { email: true } },
      },
    });
  }
}
