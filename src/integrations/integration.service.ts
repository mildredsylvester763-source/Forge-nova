import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { IntegrationStatus, Prisma } from '@prisma/client';
import { AuthenticatedApiKey } from '../api-keys/api-key.guard';
import {
  WriteActor,
  actorAttribution,
  actorAuditMetadata,
  keyActorFromApiKey,
} from '../api-keys/engine/api-key-policy';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { CreateConnectionDto } from './dto/create-connection.dto';
import {
  CONNECTORS,
  buildTestRequest,
  describeCredentials,
  lookupConnector,
  validateCredentials,
} from './engine/connector-catalog.engine';

const OUTBOUND_TIMEOUT_MS = 3000;

/**
 * The only shape a connection is ever returned in: metadata plus the
 * CREDENTIAL FIELD NAMES and their lengths. Raw values never leave
 * the vault.
 */
function toConnectionShape(row: {
  id: string;
  organizationId: string;
  connectorId: string;
  name: string;
  status: IntegrationStatus;
  credentials: unknown;
  lastTestedAt: Date | null;
  lastTestStatus: string | null;
  lastTestDetail: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const connector = lookupConnector(row.connectorId);
  return {
    id: row.id,
    organizationId: row.organizationId,
    connectorId: row.connectorId,
    name: row.name,
    status: row.status,
    credentialShape: connector.ok
      ? describeCredentials(connector.connector, (row.credentials ?? {}) as Record<string, unknown>)
      : {},
    lastTestedAt: row.lastTestedAt,
    lastTestStatus: row.lastTestStatus,
    lastTestDetail: row.lastTestDetail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class IntegrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  /** The offer: the connector catalog, org-scoped but public to members. */
  async listCatalog(userId: string, organizationId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.allRoles());
    return this.catalog();
  }

  /**
   * Key-authenticated connector catalog. Grounded in the GitHub app
   * catalog read: the offer is metadata only - named connectors with
   * named credential fields - so the rows mirror the JWT catalog
   * exactly through the shared core. The key IS the tenant bound and
   * reads never write audit rows.
   */
  listCatalogForKey(key: AuthenticatedApiKey) {
    return this.catalog();
  }

  private catalog() {
    return CONNECTORS.map((connector) => ({
      id: connector.id,
      label: connector.label,
      category: connector.category,
      description: connector.description,
      requiredCredentials: connector.requiredCredentials,
      optionalCredentials: connector.optionalCredentials,
      testable: connector.testable,
    }));
  }

  /**
   * Creates a connection. Credentials are validated against the
   * catalog (named fields only) and stored raw server-side, but the
   * response echoes only field names and lengths. A concurrent
   * double-tap on the same [organization, connector, name] gets
   * exactly one 201 and one 409.
   */
  async create(userId: string, organizationId: string, dto: CreateConnectionDto) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    return this.createForActor({ kind: 'user', userId }, organizationId, dto);
  }

  /**
   * Key-authenticated connection create. Grounded in the GitHub app
   * installation create and the Vercel integration access token
   * exchange: machine identities create integration connections
   * with scoped tokens, and a token never grants more access than
   * its owner. Keys are minted only by organization admins, so a
   * WRITE_ORGANIZATION key is an admin-delegated create bounded to
   * the key organization, and the landed create writes exactly one
   * audit row stamped via genapi with the acting key.
   */
  async createForKey(key: AuthenticatedApiKey, dto: CreateConnectionDto) {
    return this.createForActor(keyActorFromApiKey(key), key.organizationId, dto);
  }

  /**
   * The one create core shared by the JWT admin route and the genapi
   * key route, so the two surfaces can never drift apart: the same
   * catalog validation, the same vault law, the same single 409 on
   * a concurrent double-tap, and the same single audit row. A keyed
   * create attributes to the key creator and stamps the acting key
   * into the trail; a user create keeps its existing row shape
   * exactly.
   */
  private async createForActor(actor: WriteActor, organizationId: string, dto: CreateConnectionDto) {
    const name = dto.name.trim();
    if (name.length === 0) {
      throw new BadRequestException('Connection name must not be empty.');
    }

    const lookup = lookupConnector(dto.connectorId);
    if (!lookup.ok) {
      throw new BadRequestException('Unknown connector.');
    }
    const connector = lookup.connector;

    const credentials: Record<string, string> = {};
    for (const [field, value] of Object.entries(dto.credentials ?? {})) {
      credentials[field] = String(value);
    }
    const validated = validateCredentials(connector, credentials);
    if (!validated.ok) {
      const suffix = validated.field ? ' (' + validated.field + ')' : '';
      throw new BadRequestException('Invalid credentials: ' + validated.reason + suffix);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.integration.create({
          data: {
            organizationId,
            connectorId: connector.id,
            name,
            credentials,
            status: 'UNVERIFIED',
          },
        });
        await tx.auditEvent.create({
          data: {
            actorUserId: actorAttribution(actor),
            organizationId,
            action: 'integration.connection.create',
            resourceType: 'integration',
            resourceId: created.id,
            outcome: 'SUCCESS',
            metadata: actorAuditMetadata(actor, { connectorId: connector.id, name }),
          },
        });
        return toConnectionShape(created);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('A connection with this name already exists for this connector.');
      }
      throw error;
    }
  }

  /** Lists connections without ever surfacing credential values. */
  async list(userId: string, organizationId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.allRoles());
    return this.listConnectionsForOrganization(organizationId);
  }

  /**
   * Key-authenticated connection listing. Grounded in the GitHub
   * list-installations-for-an-organization read, which needs only
   * the organization administration read permission: the rows mirror
   * the JWT listing exactly through the shared core and credential
   * values never leave the vault. Reads never write audit rows.
   */
  async listForKey(key: AuthenticatedApiKey) {
    return this.listConnectionsForOrganization(key.organizationId);
  }

  private async listConnectionsForOrganization(organizationId: string) {
    const rows = await this.prisma.integration.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => toConnectionShape(row));
  }

  /**
   * Deletion is a guarded delete: two admins racing get exactly one
   * 200 and one clean 404, and only the winner is audited.
   */
  async remove(userId: string, organizationId: string, connectionId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    return this.removeForActor({ kind: 'user', userId }, organizationId, connectionId);
  }

  /**
   * Key-authenticated connection delete. Grounded in the GitHub
   * installation removal behind organization administration write:
   * a machine identity with write access may remove the
   * integration. Racing deletes get exactly one 200 and one clean
   * 404 through the shared guarded core, and the landed delete
   * writes exactly one audit row stamped via genapi with the acting
   * key.
   */
  async removeForKey(key: AuthenticatedApiKey, connectionId: string) {
    return this.removeForActor(keyActorFromApiKey(key), key.organizationId, connectionId);
  }

  private async removeForActor(actor: WriteActor, organizationId: string, connectionId: string) {
    const attributedUserId = actorAttribution(actor);
    const deleted = await this.prisma.$transaction(async (tx) => {
      const result = await tx.integration.deleteMany({
        where: { id: connectionId, organizationId },
      });
      if (result.count !== 1) return false;
      await tx.auditEvent.create({
        data: {
          actorUserId: attributedUserId,
          organizationId,
          action: 'integration.connection.delete',
          resourceType: 'integration',
          resourceId: connectionId,
          outcome: 'SUCCESS',
          metadata: actorAuditMetadata(actor, {}),
        },
      });
      return true;
    });
    if (!deleted) throw new NotFoundException('Integration connection not found.');
    return { deleted: true, connectionId };
  }

  /**
   * Performs a REAL outbound request to the connector (3s budget) and
   * records the honest outcome: succeeded, failed (remote answered
   * with an error), or unreachable (no answer at all). The stored
   * detail is the real error, never a generic excuse.
   */
  async testConnection(userId: string, organizationId: string, connectionId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    const connection = await this.findConnectionInOrganization(organizationId, connectionId);
    return this.testForActor({ kind: 'user', userId }, organizationId, connection);
  }

  /**
   * Key-authenticated connection test. Grounded in the market
   * verification law: Vercel integration access tokens are verified
   * by real requests, and GitHub installation tokens carry honest
   * installation metadata. The keyed test performs the same REAL
   * outbound request with the same honest succeeded, failed, or
   * unreachable outcome as the JWT route, foreign and unknown ids
   * answer one uniform 404, and the audit row is stamped via genapi
   * with the acting key.
   */
  async testConnectionForKey(key: AuthenticatedApiKey, connectionId: string) {
    const connection = await this.findConnectionInOrganization(key.organizationId, connectionId);
    return this.testForActor(keyActorFromApiKey(key), key.organizationId, connection);
  }

  private async findConnectionInOrganization(organizationId: string, connectionId: string) {
    const connection = await this.prisma.integration.findFirst({
      where: { id: connectionId, organizationId },
    });
    if (!connection) {
      throw new NotFoundException('Integration connection not found.');
    }
    return connection;
  }

  /**
   * The one test core shared by the JWT admin route and the genapi
   * key route: the same REAL outbound request, the same honest
   * outcome recording, and the same single audit row per test. A
   * keyed test attributes to the key creator and stamps the acting
   * key into the trail; a user test keeps its existing row shape
   * exactly.
   */
  private async testForActor(
    actor: WriteActor,
    organizationId: string,
    connection: { id: string; connectorId: string; credentials: unknown },
  ) {
    const lookup = lookupConnector(connection.connectorId);
    if (!lookup.ok) {
      throw new BadRequestException('Unknown connector.');
    }
    const request = buildTestRequest(lookup.connector, (connection.credentials ?? {}) as Record<string, unknown>);
    if (!request) {
      throw new BadRequestException('This connector has no testable request.');
    }

    let testStatus: 'succeeded' | 'failed' | 'unreachable';
    let detail: string;
    let statusCode: number | null = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
    try {
      const response = await fetch(request.url, {
        method: 'GET',
        headers: request.headers,
        signal: controller.signal,
      });
      statusCode = response.status;
      if (response.ok) {
        testStatus = 'succeeded';
        detail = 'Remote answered with HTTP ' + response.status + '.';
      } else {
        testStatus = 'failed';
        detail = 'Remote answered with HTTP ' + response.status + '.';
      }
    } catch (error) {
      testStatus = 'unreachable';
      const cause = (error as { cause?: { message?: string } }).cause?.message;
      const direct = (error as Error).message;
      detail = String(cause ?? direct ?? error).slice(0, 300);
    } finally {
      clearTimeout(timer);
    }

    const updated = await this.prisma.integration.update({
      where: { id: connection.id },
      data: {
        status: testStatus === 'succeeded' ? ('CONNECTED' as IntegrationStatus) : ('FAILED' as IntegrationStatus),
        lastTestedAt: new Date(),
        lastTestStatus: testStatus,
        lastTestDetail: detail,
      },
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: actorAttribution(actor),
        organizationId,
        action: 'integration.connection.test',
        resourceType: 'integration',
        resourceId: connection.id,
        outcome: 'SUCCESS',
        metadata: actorAuditMetadata(actor, { testStatus, statusCode, detail }),
      },
    });

    return toConnectionShape(updated);
  }
}
