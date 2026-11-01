import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MembershipRole, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AuthenticatedApiKey } from '../api-keys/api-key.guard';
import {
  WriteActor,
  actorAttribution,
  actorAuditMetadata,
  keyActorFromApiKey,
} from '../api-keys/engine/api-key-policy';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { AddMemberDto } from './dto/add-member.dto';
import { ChangeMemberRoleDto } from './dto/change-member-role.dto';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto';
import { canChangeMemberRole, canRemoveMember, MembershipPolicyRefusal } from './engine/membership-policy.engine';
import { CreateOrganizationDto } from './dto/create-organization.dto';

/**
 * The organization profile select shared by the JWT organization
 * listing rows and the key-authenticated organization profile, so
 * both surfaces answer the same fields by construction and can
 * never drift apart.
 */
const ORGANIZATION_PROFILE_SELECT = {
  id: true,
  name: true,
  slug: true,
  createdAt: true,
  _count: { select: { memberships: true, workspaces: true } },
};

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
        ...ORGANIZATION_PROFILE_SELECT,
        memberships: {
          where: { userId },
          select: { role: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Key-authenticated organization profile. Grounded in the GitHub
   * get-an-organization REST surface, where the organization profile
   * read is a first-class endpoint and a fine-grained token with
   * organization access reads the profile without any extra
   * permissions: the profile fields and live counts come from the
   * same shared profile select the JWT organization listing rows use,
   * so the two surfaces can never drift apart. The key IS the tenant
   * bound - there is no path parameter to probe, so the profile can
   * only ever be the one of the key organization. Reads never write
   * audit rows.
   */
  async getOrganizationProfileForKey(key: AuthenticatedApiKey) {
    const profile = await this.prisma.organization.findUnique({
      where: { id: key.organizationId },
      select: ORGANIZATION_PROFILE_SELECT,
    });
    if (!profile) {
      throw new NotFoundException('Organization not found.');
    }
    return profile;
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
    return this.listMembersForOrganization(organizationId);
  }

  /**
   * Shared member directory core so the JWT surface and the
   * key-authenticated surface can never drift apart. Oldest first,
   * the same creation order the directory grew in, so the two
   * listings answer byte-identical rows.
   */
  private listMembersForOrganization(organizationId: string) {
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

  /**
   * Key-authenticated organization member directory. Grounded in
   * the GitHub org members listing, where reading who belongs to
   * an organization needs only the Members organization read
   * permission: keys are minted only by organization admins, so a
   * READ_ORGANIZATION key is an admin-delegated read exactly like
   * the audit trail delegation, and the key IS the tenant bound -
   * there is no path parameter to probe, so the directory can
   * only ever be the one of the key organization. Reads never
   * write audit rows.
   */
  async listMembersForKey(key: AuthenticatedApiKey) {
    return this.listMembersForOrganization(key.organizationId);
  }

  async addMember(userId: string, organizationId: string, dto: AddMemberDto) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    return this.addMemberToOrganization({ kind: 'user', userId }, organizationId, dto);
  }

  /**
   * Key-authenticated member add. Grounded in the GitHub add-or-update
   * organization membership surface, where managing membership runs
   * behind the Members organization write permission and a token never
   * grants more access than its owner: keys are minted only by
   * organization admins, so a WRITE_ORGANIZATION key is an
   * admin-delegated add bounded to the key organization, and the landed
   * add writes exactly one audit row stamped via genapi with the
   * acting key.
   */
  async addMemberForKey(key: AuthenticatedApiKey, dto: AddMemberDto) {
    return this.addMemberToOrganization(keyActorFromApiKey(key), key.organizationId, dto);
  }

  /**
   * The one add core shared by the JWT admin route and the genapi key
   * route, so the two surfaces can never drift apart: the same owner
   * role refusal, the same active-account lookup, the same single
   * clean 409 on a concurrent duplicate add, and the same single
   * audit row.
   */
  private async addMemberToOrganization(actor: WriteActor, organizationId: string, dto: AddMemberDto) {
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
            actorUserId: actorAttribution(actor),
            organizationId,
            action: 'organization.member.add',
            resourceType: 'membership',
            resourceId: membership.id,
            outcome: 'SUCCESS',
            metadata: actorAuditMetadata(actor, { role: dto.role }),
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
    return this.changeMemberRoleForActor({ kind: 'user', userId }, organizationId, membershipId, dto);
  }

  /**
   * Key-authenticated member role change. Grounded in the GitHub
   * membership update behind the Members organization write
   * permission: keys are minted only by organization admins, so a
   * WRITE_ORGANIZATION key is an admin-delegated role change bounded
   * to the key organization. Foreign and unknown membership ids answer
   * one uniform 404, the policy engine decides exactly as for the JWT
   * route, and the landed change writes exactly one audit row stamped
   * via genapi with the acting key.
   */
  async changeMemberRoleForKey(
    key: AuthenticatedApiKey,
    membershipId: string,
    dto: ChangeMemberRoleDto,
  ) {
    return this.changeMemberRoleForActor(
      keyActorFromApiKey(key),
      key.organizationId,
      membershipId,
      dto,
    );
  }

  /**
   * The one role-change core shared by the JWT admin route and the
   * genapi key route, so the two surfaces can never drift apart: the
   * same org-bound membership lookup, the same owner-count policy
   * decision, and the same single audit row.
   */
  private async changeMemberRoleForActor(
    actor: WriteActor,
    organizationId: string,
    membershipId: string,
    dto: ChangeMemberRoleDto,
  ) {
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
        actorUserId: actorAttribution(actor),
        organizationId,
        action: 'organization.member.role.change',
        resourceType: 'membership',
        resourceId: membershipId,
        outcome: 'SUCCESS',
        metadata: actorAuditMetadata(actor, { previousRole: membership.role, newRole: dto.role }),
      },
    });
    return updated;
  }

  async removeMember(userId: string, organizationId: string, membershipId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    return this.removeMemberForActor({ kind: 'user', userId }, organizationId, membershipId);
  }

  /**
   * Key-authenticated member removal. Grounded in the GitHub remove an
   * organization member surface behind the Members organization write
   * permission: keys are minted only by organization admins, so a
   * WRITE_ORGANIZATION key is an admin-delegated removal bounded to the
   * key organization. Foreign and unknown membership ids answer one
   * uniform 404, the owner-protection policy decides exactly as for
   * the JWT route, and the guarded delete hands racing removals
   * exactly one clean outcome.
   */
  async removeMemberForKey(key: AuthenticatedApiKey, membershipId: string) {
    return this.removeMemberForActor(keyActorFromApiKey(key), key.organizationId, membershipId);
  }

  /**
   * The one removal core shared by the JWT admin route and the genapi
   * key route, so the two surfaces can never drift apart: the same
   * org-bound lookup, the same owner-protection refusal, and the same
   * guarded delete that hands racing callers exactly one clean
   * outcome and exactly one audit row.
   */
  private async removeMemberForActor(
    actor: WriteActor,
    organizationId: string,
    membershipId: string,
  ) {
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
    // Guarded delete: two admins pressing remove at the same time must not
    // race into a raw record-not-found error; the loser gets a clean 404
    // and no audit event is written for it.
    const removal = await this.prisma.membership.deleteMany({
      where: { id: membershipId },
    });
    if (removal.count !== 1) {
      throw new NotFoundException('Membership not found.');
    }
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: actorAttribution(actor),
        organizationId,
        action: 'organization.member.remove',
        resourceType: 'membership',
        resourceId: membershipId,
        outcome: 'SUCCESS',
        metadata: actorAuditMetadata(actor, { removedUserId: membership.userId, role: membership.role }),
      },
    });
    return { removed: true, membershipId };
  }

  async transferOwnership(userId: string, organizationId: string, dto: TransferOwnershipDto) {
    const ownerMembership = await this.requireOwnerMembership(userId, organizationId);
    return this.transferOwnershipFromOwner(
      { kind: 'user', userId },
      ownerMembership,
      organizationId,
      dto,
    );
  }

  /**
   * Key-authenticated ownership transfer. Grounded in the GitHub
   * organization role assignment law: ownership changes are
   * owner-only actions, and a token never grants more access than
   * its owner - if the owner of the token is not an organization
   * owner the capability is absent. A key acts as its creator, so
   * the transfer only runs while the key creator still holds OWNER
   * in the key organization, with the same gates, messages, and
   * audit shape as the JWT route through the one shared core.
   */
  async transferOwnershipForKey(key: AuthenticatedApiKey, dto: TransferOwnershipDto) {
    const actor = keyActorFromApiKey(key);
    const attributedUserId = actorAttribution(actor);
    if (attributedUserId === null) {
      throw new ForbiddenException('Only an owner can transfer ownership.');
    }
    const ownerMembership = await this.requireOwnerMembership(attributedUserId, key.organizationId);
    return this.transferOwnershipFromOwner(actor, ownerMembership, key.organizationId, dto);
  }

  private async requireOwnerMembership(userId: string, organizationId: string) {
    const ownerMembership = await this.prisma.membership.findFirst({
      where: { userId, organizationId, role: MembershipRole.OWNER },
      select: { id: true },
    });
    if (!ownerMembership) {
      throw new ForbiddenException('Only an owner can transfer ownership.');
    }
    return ownerMembership;
  }

  /**
   * The one transfer core shared by the JWT route and the genapi key
   * route, so the two surfaces can never drift apart: the same
   * org-bound target lookup, the same self-transfer refusal, the same
   * owner swap, and the same single audit row. The sitting owner
   * membership is demoted to ADMIN so the organization always keeps
   * exactly one owner.
   */
  private async transferOwnershipFromOwner(
    actor: WriteActor,
    ownerMembership: { id: string },
    organizationId: string,
    dto: TransferOwnershipDto,
  ) {
    const attributedUserId = actorAttribution(actor);
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.membership.findUnique({
        where: { id: dto.memberId },
        select: { id: true, userId: true, organizationId: true },
      });
      if (!target || target.organizationId !== organizationId) {
        throw new NotFoundException('Target membership not found.');
      }
      if (target.userId === attributedUserId) {
        throw new BadRequestException('You already own this organization.');
      }
      await tx.membership.update({ where: { id: target.id }, data: { role: MembershipRole.OWNER } });
      await tx.membership.update({ where: { id: ownerMembership.id }, data: { role: MembershipRole.ADMIN } });
      await tx.auditEvent.create({
        data: {
          actorUserId: attributedUserId,
          organizationId,
          action: 'organization.ownership.transfer',
          resourceType: 'membership',
          resourceId: target.id,
          outcome: 'SUCCESS',
          metadata: actorAuditMetadata(actor, { previousOwnerId: attributedUserId, newOwnerId: target.userId }),
        },
      });
      return {
        organizationId,
        previousOwnerId: attributedUserId,
        newOwnerId: target.userId,
      };
    });
  }

  /**
   * Shared audit listing core so the JWT admin surface and the
   * key-authenticated surface can never drift apart. Newest first,
   * capped at 50 - the same default-desc law the GitHub audit log
   * REST listing follows.
   */
  private async listAuditEventsForOrganization(organizationId: string) {
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

  async listAuditEvents(userId: string, organizationId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    return this.listAuditEventsForOrganization(organizationId);
  }

  /**
   * Key-authenticated organization audit trail. Grounded in the GitHub
   * audit log REST surface: reading audit data is a deliberately gated
   * read behind a dedicated read permission, and the trail comes back
   * newest first. The key is the tenant bound - there is no path
   * parameter to probe, so a key can only ever read the trail of its
   * own organization. Reads never write audit rows.
   */
  async listAuditEventsForKey(key: AuthenticatedApiKey) {
    return this.listAuditEventsForOrganization(key.organizationId);
  }
}
