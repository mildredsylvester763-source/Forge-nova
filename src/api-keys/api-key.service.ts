import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ApiKeyScope } from '@prisma/client';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { AuthenticatedApiKey } from './api-key.guard';
import {
  ApiKeyRefusal,
  REFUSAL_MESSAGES,
  buildKeyMaterial,
  hashApiKey,
  isKeyUsable,
  keyLooksLikeApiKey,
  normalizeScopes,
  planExpiry,
} from './engine/api-key-policy';

const API_KEY_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  displayHint: true,
  scopes: true,
  createdBy: true,
  expiresAt: true,
  revokedAt: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ApiKeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  /**
   * Creates a key and returns the plaintext EXACTLY ONCE. The database
   * stores only the SHA-256 hash; the plaintext is never persisted and
   * never shown again after this response.
   */
  async create(userId: string, organizationId: string, dto: CreateApiKeyDto) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());

    const name = dto.name.trim();
    if (name.length === 0) {
      throw new BadRequestException(REFUSAL_MESSAGES['api-key.name-empty']);
    }
    if (name.length > 100) {
      throw new BadRequestException(REFUSAL_MESSAGES['api-key.name-too-long']);
    }

    const normalized = normalizeScopes(dto.scopes);
    if (typeof normalized === 'string') {
      throw new BadRequestException(REFUSAL_MESSAGES[normalized as ApiKeyRefusal]);
    }

    const expiry = planExpiry(
      dto.expiresAt === undefined ? undefined : new Date(dto.expiresAt),
      new Date(),
    );
    if (typeof expiry === 'string') {
      throw new BadRequestException(REFUSAL_MESSAGES[expiry]);
    }

    const material = buildKeyMaterial(randomBytes(32).toString('base64url'));

    const created = await this.prisma.$transaction(async (tx) => {
      const key = await tx.apiKey.create({
        data: {
          organizationId,
          name,
          hashedKey: material.hashedKey,
          displayHint: material.displayHint,
          scopes: normalized.scopes as ApiKeyScope[],
          createdBy: userId,
          expiresAt: expiry.expiresAt,
        },
        select: API_KEY_SELECT,
      });
      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          organizationId,
          action: 'apikey.create',
          resourceType: 'api_key',
          resourceId: key.id,
          outcome: 'SUCCESS',
          metadata: { name, scopes: normalized.scopes },
        },
      });
      return key;
    });

    return { ...created, key: material.rawKey };
  }

  /**
   * Lists an organization's keys. Never exposes hashes or plaintext,
   * only the masked hint so humans can identify a key in a dashboard.
   */
  async list(userId: string, organizationId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    return this.listApiKeysForOrganization(organizationId);
  }

  /**
   * Shared key inventory core so the JWT admin surface and the
   * key-authenticated surface can never drift apart. Newest first,
   * masked hints only: the hash and the plaintext never appear in
   * any listing, exactly like the masked key inventories the market
   * leaders keep.
   */
  private listApiKeysForOrganization(organizationId: string) {
    return this.prisma.apiKey.findMany({
      where: { organizationId },
      select: API_KEY_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Key-authenticated key inventory. Grounded in the GitHub org
   * personal access token review surface, where organization owners
   * inspect the member token inventory with metadata only, while
   * Stripe keeps its key inventory dashboard-only: keys are minted
   * only by organization admins, so a READ_ORGANIZATION key is an
   * admin-delegated inventory read exactly like the audit trail and
   * member directory delegations, and the key IS the tenant bound -
   * there is no path parameter to probe, so the inventory can only
   * ever be the one of the key organization. Reads never write
   * audit rows.
   */
  async listForKey(key: AuthenticatedApiKey) {
    return this.listApiKeysForOrganization(key.organizationId);
  }

  /**
   * Revocation is a guarded update: two admins pressing revoke at the same
   * time get exactly one 200 and one clean 404, and only the winner is
   * audited.
   */
  async revoke(userId: string, organizationId: string, keyId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    const now = new Date();
    const revoked = await this.prisma.$transaction(async (tx) => {
      const result = await tx.apiKey.updateMany({
        where: { id: keyId, organizationId, revokedAt: null },
        data: { revokedAt: now },
      });
      if (result.count !== 1) return false;
      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          organizationId,
          action: 'apikey.revoke',
          resourceType: 'api_key',
          resourceId: keyId,
          outcome: 'SUCCESS',
          metadata: {},
        },
      });
      return true;
    });
    if (!revoked) throw new NotFoundException('API key not found.');
    return { revoked: true, apiKeyId: keyId };
  }

  /**
   * Authenticates a raw key against the stored hash. Returns null for any
   * unusable key (unknown, revoked, expired) so the caller can answer with
   * a single uniform 401 that does not disclose which check failed.
   */
  async authenticate(rawKey: string) {
    if (!keyLooksLikeApiKey(rawKey)) return null;
    const key = await this.prisma.apiKey.findUnique({
      where: { hashedKey: hashApiKey(rawKey) },
      select: {
        id: true,
        organizationId: true,
        name: true,
        scopes: true,
        revokedAt: true,
        expiresAt: true,
        createdBy: true,
      },
    });
    if (!key) return null;
    const usable = isKeyUsable(
      { revokedAt: key.revokedAt, expiresAt: key.expiresAt },
      new Date(),
    );
    if (typeof usable === 'string') return null;

    // Last-used bookkeeping must never block authentication.
    await this.prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return {
      id: key.id,
      organizationId: key.organizationId,
      name: key.name,
      scopes: key.scopes,
      createdBy: key.createdBy,
    };
  }

  /**
   * Key-authenticated read surface. Scope enforcement happens in the
   * guard; these queries are additionally constrained to the key's own
   * organization so a key can never cross tenant boundaries.
   */
  async listOrganizationProjects(organizationId: string) {
    return this.prisma.project.findMany({
      where: { workspace: { organizationId }, status: { not: 'DELETED' } },
      select: {
        id: true,
        name: true,
        status: true,
        workspace: { select: { id: true, name: true } },
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listOrganizationApplications(organizationId: string) {
    return this.prisma.application.findMany({
      where: { project: { workspace: { organizationId } }, status: { not: 'ARCHIVED' } },
      select: {
        id: true,
        name: true,
        status: true,
        framework: true,
        runtime: true,
        project: { select: { id: true, name: true } },
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
