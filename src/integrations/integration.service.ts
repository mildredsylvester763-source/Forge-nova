import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { IntegrationStatus, Prisma } from '@prisma/client';
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
            actorUserId: userId,
            organizationId,
            action: 'integration.connection.create',
            resourceType: 'integration',
            resourceId: created.id,
            outcome: 'SUCCESS',
            metadata: { connectorId: connector.id, name },
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
    const deleted = await this.prisma.$transaction(async (tx) => {
      const result = await tx.integration.deleteMany({
        where: { id: connectionId, organizationId },
      });
      if (result.count !== 1) return false;
      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          organizationId,
          action: 'integration.connection.delete',
          resourceType: 'integration',
          resourceId: connectionId,
          outcome: 'SUCCESS',
          metadata: {},
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
    const connection = await this.prisma.integration.findUnique({
      where: { id: connectionId },
    });
    if (!connection || connection.organizationId !== organizationId) {
      throw new NotFoundException('Integration connection not found.');
    }

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
        actorUserId: userId,
        organizationId,
        action: 'integration.connection.test',
        resourceType: 'integration',
        resourceId: connection.id,
        outcome: 'SUCCESS',
        metadata: { testStatus, statusCode, detail },
      },
    });

    return toConnectionShape(updated);
  }
}
