import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AccessControlService } from '../authorization/access-control.service';
import { AuthenticatedApiKey } from '../api-keys/api-key.guard';
import { actorAuditMetadata, actorAttribution, keyActorFromApiKey, WriteActor } from '../api-keys/engine/api-key-policy';
import { PrismaService } from '../database/prisma.service';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { DispatchEventDto } from './dto/dispatch-event.dto';
import { UpdateWebhookEndpointDto } from './dto/update-webhook-endpoint.dto';
import { backoffSeconds, canRetryNow, nextDeliveryStatus } from './engine/delivery-backoff.engine';
import { parseDeliveryStatusFilter } from './engine/delivery-status.engine';
import { matchesSubscriptions, validateEventName, validateSubscription } from './engine/event-subscription.engine';
import { buildSystemPayload } from './engine/system-events.engine';
import { SIGNATURE_HEADER, signPayload } from './engine/webhook-signature.engine';

const OUTBOUND_TIMEOUT_MS = 3000;

/** The public endpoint shape: the signing secret is NEVER included. */
const ENDPOINT_SELECT = {
  id: true,
  organizationId: true,
  url: true,
  eventSubscriptions: true,
  active: true,
  lastSuccessAt: true,
  lastFailureAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const DELIVERY_SELECT = {
  id: true,
  endpointId: true,
  organizationId: true,
  eventName: true,
  status: true,
  attempts: true,
  lastStatusCode: true,
  lastError: true,
  deliveredAt: true,
  nextAttemptAt: true,
  createdAt: true,
} as const;

@Injectable()
export class WebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  /**
   * Creates an endpoint, generating a signing secret that is returned
   * EXACTLY ONCE in the creation response and never again.
   */
  async createEndpoint(userId: string, organizationId: string, dto: CreateWebhookEndpointDto) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    return this.createEndpointAsActor({ kind: 'user', userId }, organizationId, dto);
  }

  /**
   * Key-authenticated endpoint create, grounded in the Stripe webhook
   * endpoint create REST surface, where a write-capable key creates the
   * endpoint and the response carries the signing secret exactly once
   * (the Stripe secret field is populated on create): keys are minted
   * only by organization admins, so a WRITE_ORGANIZATION key is an
   * admin-delegated write, and the reveal-once secret goes to the
   * acting key. The create lands exactly one audit row stamped via
   * genapi with the acting key, and refusals never write audit rows.
   */
  async createEndpointForKey(key: AuthenticatedApiKey, dto: CreateWebhookEndpointDto) {
    return this.createEndpointAsActor(keyActorFromApiKey(key), key.organizationId, dto);
  }

  private async createEndpointAsActor(
    actor: WriteActor,
    organizationId: string,
    dto: CreateWebhookEndpointDto,
  ) {

    let parsed: URL;
    try {
      parsed = new URL(dto.url);
    } catch {
      throw new BadRequestException('Webhook URL must be a valid URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('Webhook URL must use http or https.');
    }

    const subscriptions: string[] = [];
    for (const subscription of dto.eventSubscriptions) {
      const validated = validateSubscription(subscription);
      if (!validated.ok) {
        throw new BadRequestException('Invalid event subscription: ' + subscription);
      }
      if (!subscriptions.includes(subscription)) {
        subscriptions.push(subscription);
      }
    }

    const secret = 'whsec_' + randomBytes(24).toString('hex');

    try {
      return await this.prisma.$transaction(async (tx) => {
        const endpoint = await tx.webhookEndpoint.create({
          data: {
            organizationId,
            url: dto.url,
            secret,
            eventSubscriptions: subscriptions,
            active: true,
          },
          select: ENDPOINT_SELECT,
        });
        await tx.auditEvent.create({
          data: {
            actorUserId: actorAttribution(actor),
            organizationId,
            action: 'webhook.endpoint.create',
            resourceType: 'webhook_endpoint',
            resourceId: endpoint.id,
            outcome: 'SUCCESS',
            metadata: actorAuditMetadata(actor, { url: dto.url, eventSubscriptions: subscriptions }),
          },
        });
        return { ...endpoint, secret };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('A webhook endpoint with this URL already exists.');
      }
      throw error;
    }
  }

  /** Lists endpoints without secrets. */
  async listEndpoints(userId: string, organizationId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.allRoles());
    return this.listEndpointsCore(organizationId);
  }

  /**
   * Key-authenticated endpoint listing. Grounded in the Stripe webhook
   * endpoints REST surface, where the listing runs with a restricted
   * read key, an empty organization answers an honest empty array
   * instead of an error, and the signing secret never appears in a
   * read. The listing mirrors the JWT surface exactly through the
   * shared core, tenant-bounded to the key organization, and reads
   * never write audit rows.
   */
  async listEndpointsForKey(key: AuthenticatedApiKey) {
    return this.listEndpointsCore(key.organizationId);
  }

  private listEndpointsCore(organizationId: string) {
    return this.prisma.webhookEndpoint.findMany({
      where: { organizationId },
      select: ENDPOINT_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Guarded delete: racing deletes get one 200 and one 404. */
  async removeEndpoint(userId: string, organizationId: string, endpointId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    return this.removeEndpointAsActor({ kind: 'user', userId }, organizationId, endpointId);
  }

  /**
   * Key-authenticated endpoint delete, grounded in the GitHub repo
   * webhook delete (the Webhooks write permission): deleting an
   * endpoint immediately stops its deliveries. The guarded delete
   * mirrors the JWT route exactly through the shared core - racing
   * deletes get one 200 and one 404 - tenant-bounded to the key
   * organization with one uniform 404, and the delete lands exactly
   * one audit row stamped via genapi with the acting key.
   */
  async removeEndpointForKey(key: AuthenticatedApiKey, endpointId: string) {
    return this.removeEndpointAsActor(keyActorFromApiKey(key), key.organizationId, endpointId);
  }

  private async removeEndpointAsActor(
    actor: WriteActor,
    organizationId: string,
    endpointId: string,
  ) {
    const deleted = await this.prisma.$transaction(async (tx) => {
      const result = await tx.webhookEndpoint.deleteMany({
        where: { id: endpointId, organizationId },
      });
      if (result.count !== 1) return false;
      await tx.auditEvent.create({
        data: {
          actorUserId: actorAttribution(actor),
          organizationId,
          action: 'webhook.endpoint.delete',
          resourceType: 'webhook_endpoint',
          resourceId: endpointId,
          outcome: 'SUCCESS',
          metadata: actorAuditMetadata(actor, {}),
        },
      });
      return true;
    });
    if (!deleted) throw new NotFoundException('Webhook endpoint not found.');
    return { deleted: true, endpointId };
  }

  /**
   * Partial endpoint update, grounded in the GitHub webhook update
   * (Webhooks write permission) and the Stripe webhook endpoint update:
   * only the fields sent change and everything else stays untouched.
   * The signing secret is deliberately not updatable, so deliveries
   * keep being signed with the original reveal-once secret whatever
   * the update changes. A PATCH that provides no fields is an honest
   * no-op that returns the current row and writes no audit row; any
   * provided field lands exactly one audit row. Unknown, foreign, and
   * concurrently deleted endpoints all answer one uniform 404, and a
   * URL already used by another endpoint in the organization answers
   * the same conflict as the create route.
   */
  async updateEndpoint(
    userId: string,
    organizationId: string,
    endpointId: string,
    dto: UpdateWebhookEndpointDto,
  ) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    return this.updateEndpointAsActor({ kind: 'user', userId }, organizationId, endpointId, dto);
  }

  /**
   * Key-authenticated partial endpoint update, grounded in the market
   * leaders: the Stripe webhook endpoint update changes only the
   * fields that were sent, and the GitHub webhook update runs behind
   * the Webhooks write permission. The keyed update mirrors the JWT
   * PATCH exactly through the shared core - same partial law, same
   * honest no-op for an empty body, same uniform 404, same URL
   * conflict - tenant-bounded to the key organization, and every
   * landed update writes exactly one audit row stamped via genapi
   * with the acting key.
   */
  async updateEndpointForKey(
    key: AuthenticatedApiKey,
    endpointId: string,
    dto: UpdateWebhookEndpointDto,
  ) {
    return this.updateEndpointAsActor(
      keyActorFromApiKey(key),
      key.organizationId,
      endpointId,
      dto,
    );
  }

  private async updateEndpointAsActor(
    actor: WriteActor,
    organizationId: string,
    endpointId: string,
    dto: UpdateWebhookEndpointDto,
  ) {

    const hasUrl = typeof dto.url === 'string';
    const hasSubscriptions = Array.isArray(dto.eventSubscriptions);
    const hasActive = typeof dto.active === 'boolean';

    if (!hasUrl && !hasSubscriptions && !hasActive) {
      const current = await this.prisma.webhookEndpoint.findFirst({
        where: { id: endpointId, organizationId },
        select: ENDPOINT_SELECT,
      });
      if (!current) throw new NotFoundException('Webhook endpoint not found.');
      return current;
    }

    if (hasUrl) {
      let parsed: URL;
      try {
        parsed = new URL(dto.url!);
      } catch {
        throw new BadRequestException('Webhook URL must be a valid URL.');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new BadRequestException('Webhook URL must use http or https.');
      }
    }

    let subscriptions: string[] | undefined;
    if (hasSubscriptions) {
      subscriptions = [];
      for (const subscription of dto.eventSubscriptions!) {
        const validated = validateSubscription(subscription);
        if (!validated.ok) {
          throw new BadRequestException('Invalid event subscription: ' + subscription);
        }
        if (!subscriptions.includes(subscription)) {
          subscriptions.push(subscription);
        }
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const result = await tx.webhookEndpoint.updateMany({
          where: { id: endpointId, organizationId },
          data: {
            ...(hasUrl ? { url: dto.url! } : {}),
            ...(hasSubscriptions ? { eventSubscriptions: subscriptions! } : {}),
            ...(hasActive ? { active: dto.active! } : {}),
          },
        });
        if (result.count !== 1) throw new NotFoundException('Webhook endpoint not found.');
        const endpoint = await tx.webhookEndpoint.findUnique({
          where: { id: endpointId },
          select: ENDPOINT_SELECT,
        });
        await tx.auditEvent.create({
          data: {
            actorUserId: actorAttribution(actor),
            organizationId,
            action: 'webhook.endpoint.update',
            resourceType: 'webhook_endpoint',
            resourceId: endpointId,
            outcome: 'SUCCESS',
            metadata: actorAuditMetadata(actor, {
              ...(hasUrl ? { url: dto.url! } : {}),
              ...(hasSubscriptions ? { eventSubscriptions: subscriptions! } : {}),
              ...(hasActive ? { active: dto.active! } : {}),
            }),
          },
        });
        return endpoint!;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('A webhook endpoint with this URL already exists.');
      }
      throw error;
    }
  }

  /**
   * Ping, grounded in the GitHub org webhook ping (POST /orgs/{org}/
   * hooks/{hook_id}/pings behind the Webhooks write permission): the
   * ping is the market-standard confirmation that an endpoint is
   * configured and reachable, sent when the operator asks for it.
   * A ping is a health check, not a real event, so it goes to the
   * named endpoint regardless of subscriptions and regardless of
   * the active flag - an operator may want to verify a receiver
   * before re-enabling it. Exactly one delivery row (eventName
   * ping) with one synchronous signed attempt is created, the
   * honest attempt outcome comes back in the same shape as the
   * dispatch and retry results, and the recorded row stays
   * retryable through the same backoff schedule as any other
   * delivery. Unknown, foreign, and concurrently deleted endpoints
   * all answer one uniform 404, and every landed ping writes
   * exactly one audit row.
   */
  async pingEndpoint(userId: string, organizationId: string, endpointId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    return this.pingEndpointAsActor({ kind: 'user', userId }, organizationId, endpointId);
  }

  /**
   * Key-authenticated endpoint ping, grounded in the GitHub org
   * webhook ping behind the Webhooks write permission: the ping is
   * the market-standard confirmation that an endpoint is configured
   * and reachable, sent when the operator asks for it. The keyed
   * ping mirrors the JWT ping exactly through the shared core - one
   * honest delivery row with one synchronous signed attempt -
   * tenant-bounded to the key organization with one uniform 404, and
   * every landed ping writes exactly one audit row stamped via
   * genapi with the acting key.
   */
  async pingEndpointForKey(key: AuthenticatedApiKey, endpointId: string) {
    return this.pingEndpointAsActor(keyActorFromApiKey(key), key.organizationId, endpointId);
  }

  private async pingEndpointAsActor(
    actor: WriteActor,
    organizationId: string,
    endpointId: string,
  ) {

    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, organizationId },
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found.');

    const delivery = await this.createDeliveryForEndpoint(
      endpoint.id,
      organizationId,
      'ping',
      {
        endpointId: endpoint.id,
        url: endpoint.url,
        eventSubscriptions: endpoint.eventSubscriptions,
        active: endpoint.active,
      } as unknown as Prisma.InputJsonValue,
    );
    if (!delivery) throw new NotFoundException('Webhook endpoint not found.');

    const outcome = await this.attemptDelivery(delivery.id);
    const result = outcome ?? {
      deliveryId: delivery.id,
      endpointId: endpoint.id,
      status: delivery.status,
      attempts: delivery.attempts,
      lastStatusCode: null,
      lastError: 'attempt already in progress',
    };

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: actorAttribution(actor),
        organizationId,
        action: 'webhook.endpoint.ping',
        resourceType: 'webhook_delivery',
        resourceId: delivery.id,
        outcome: 'SUCCESS',
        metadata: actorAuditMetadata(actor, { endpointId: endpoint.id, status: result.status, attempts: result.attempts }),
      },
    });

    return result;
  }

  /**
   * Signing-secret rotation, grounded in the market-wide law that a
   * webhook secret must be replaceable without deleting the endpoint:
   * GitHub rotates the secret through the update config.secret surface
   * and the industry pattern for reveal-once secret stores is a
   * dedicated rotate route that hands back the raw secret exactly
   * once. GENESIS keeps the PATCH blind to the secret by design, so
   * this route is the only surface that can ever reveal a secret
   * again: the previous secret is invalidated immediately - the
   * receiver updates its verifier with the revealed value - with no
   * Stripe-style dual-signing overlap window, because an overlap
   * would need a second stored secret and a schema change. The claim
   * is an atomic updateMany, so a rotation racing an endpoint delete
   * ends in one clean way whatever order the writes land in, and
   * every landed rotation writes exactly one audit row.
   */
  async rotateEndpointSecret(userId: string, organizationId: string, endpointId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    return this.rotateEndpointSecretAsActor({ kind: 'user', userId }, organizationId, endpointId);
  }

  /**
   * Key-authenticated signing-secret rotation, grounded in the GitHub
   * secret rotation through the update config.secret surface: keys
   * are minted only by organization admins, so a WRITE_ORGANIZATION
   * key is an admin-delegated rotation, and the fresh reveal-once
   * secret goes to the acting key exactly like the create reveal.
   * The rotation mirrors the JWT route exactly through the shared
   * core - atomic updateMany claim, immediate invalidation, no
   * overlap window - tenant-bounded to the key organization with one
   * uniform 404, and every landed rotation writes exactly one audit
   * row stamped via genapi with the acting key.
   */
  async rotateEndpointSecretForKey(key: AuthenticatedApiKey, endpointId: string) {
    return this.rotateEndpointSecretAsActor(keyActorFromApiKey(key), key.organizationId, endpointId);
  }

  private async rotateEndpointSecretAsActor(
    actor: WriteActor,
    organizationId: string,
    endpointId: string,
  ) {

    const secret = 'whsec_' + randomBytes(24).toString('hex');

    const rotated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.webhookEndpoint.updateMany({
        where: { id: endpointId, organizationId },
        data: { secret },
      });
      if (result.count !== 1) return null;
      const endpoint = await tx.webhookEndpoint.findUnique({
        where: { id: endpointId },
        select: ENDPOINT_SELECT,
      });
      await tx.auditEvent.create({
        data: {
          actorUserId: actorAttribution(actor),
          organizationId,
          action: 'webhook.endpoint.rotate_secret',
          resourceType: 'webhook_endpoint',
          resourceId: endpointId,
          outcome: 'SUCCESS',
          metadata: actorAuditMetadata(actor, {}),
        },
      });
      return endpoint;
    });
    if (!rotated) throw new NotFoundException('Webhook endpoint not found.');
    return { ...rotated, secret };
  }

  /**
   * Dispatches an event: every ACTIVE endpoint whose subscriptions
   * match the event gets one delivery row and one SYNCHRONOUS signed
   * attempt. No matching endpoints is an honest zero, not an error.
   */
  async dispatch(userId: string, organizationId: string, dto: DispatchEventDto) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.writeRoles());

    const validated = validateEventName(dto.eventName);
    if (!validated.ok) {
      throw new BadRequestException('Unknown event name: ' + dto.eventName);
    }

    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { organizationId, active: true },
    });
    const matching = endpoints.filter((endpoint) =>
      matchesSubscriptions(endpoint.eventSubscriptions, dto.eventName),
    );

    const results = [];
    for (const endpoint of matching) {
      const delivery = await this.createDeliveryForEndpoint(
        endpoint.id,
        organizationId,
        dto.eventName,
        (dto.payload ?? {}) as Prisma.InputJsonValue,
      );
      if (!delivery) {
        continue;
      }
      const outcome = await this.attemptDelivery(delivery.id);
      results.push(outcome ?? {
        deliveryId: delivery.id,
        endpointId: endpoint.id,
        status: delivery.status,
        attempts: delivery.attempts,
        lastStatusCode: null,
        lastError: 'attempt already in progress',
      });
    }

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        organizationId,
        action: 'webhook.dispatch',
        resourceType: 'webhook_delivery',
        resourceId: dto.eventName,
        outcome: 'SUCCESS',
        metadata: {
          eventName: dto.eventName,
          matchedEndpoints: matching.length,
        },
      },
    });

    return {
      eventName: dto.eventName,
      matchedEndpoints: matching.length,
      deliveries: results,
    };
  }

  /**
   * Manual retry. Honors the backoff schedule: too-early and
   * exhausted are both 409s. Two concurrent retries of the same
   * delivery get exactly one 201 and one 409 - the attempt claim
   * is an atomic updateMany that flips PENDING to IN_FLIGHT, so
   * the loser can never double-send, whatever order it reads in.
   */
  async retry(userId: string, organizationId: string, deliveryId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.writeRoles());
    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, organizationId },
      include: { endpoint: true },
    });
    if (!delivery || !delivery.endpoint) {
      throw new NotFoundException('Webhook delivery not found.');
    }

    const gate = canRetryNow({
      status: delivery.status,
      attempts: delivery.attempts,
      nextAttemptAt: delivery.nextAttemptAt,
      now: new Date(),
    });
    if (!gate.ok) {
      if (gate.reason === 'webhook-retry-too-early') {
        throw new ConflictException('Retry is not due yet.');
      }
      throw new ConflictException('No retries remain for this delivery.');
    }

    const outcome = await this.attemptDelivery(deliveryId);
    if (!outcome) {
      throw new ConflictException('Delivery is already being attempted.');
    }

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        organizationId,
        action: 'webhook.retry',
        resourceType: 'webhook_delivery',
        resourceId: deliveryId,
        outcome: 'SUCCESS',
        metadata: { status: outcome.status, attempts: outcome.attempts },
      },
    });
    return outcome;
  }

  /** Delivery history, most recent first, capped at 50. */
  async listDeliveries(userId: string, organizationId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.allRoles());
    return this.prisma.webhookDelivery.findMany({
      where: { organizationId },
      select: DELIVERY_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /**
   * Per-endpoint delivery history, grounded in the GitHub hook
   * deliveries listing: reading delivery history needs only read
   * permission, the rows come back newest first capped at 100 like
   * the GitHub per_page maximum, and the status filter is a real
   * predicate - an unknown value is a named 400, never a silently
   * ignored filter. Foreign, cross-organization, and unknown
   * endpoint ids all answer the same uniform 404, and reads never
   * write audit rows.
   */
  async listEndpointDeliveries(
    userId: string,
    organizationId: string,
    endpointId: string,
    status?: string,
  ) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.allRoles());
    return this.listEndpointDeliveriesCore(organizationId, endpointId, status);
  }

  /**
   * Key-authenticated per-endpoint delivery history, mirroring the JWT
   * route exactly through the shared core: the same real status
   * predicate, the same newest-first capped-at-100 rows, and one
   * uniform 404 for foreign, cross-organization, and unknown
   * endpoint ids. Reads never write audit rows.
   */
  async listEndpointDeliveriesForKey(
    key: AuthenticatedApiKey,
    endpointId: string,
    status?: string,
  ) {
    return this.listEndpointDeliveriesCore(key.organizationId, endpointId, status);
  }

  private async listEndpointDeliveriesCore(
    organizationId: string,
    endpointId: string,
    status?: string,
  ) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, organizationId },
      select: { id: true },
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found.');
    const parsed = parseDeliveryStatusFilter(status);
    if (!parsed.ok) {
      throw new BadRequestException('Unknown delivery status: ' + status);
    }
    return this.prisma.webhookDelivery.findMany({
      where: {
        endpointId,
        ...(parsed.status === undefined ? {} : { status: parsed.status }),
      },
      select: DELIVERY_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /**
   * Single delivery inspection, grounded in the GitHub single
   * delivery read: the payload and the recorded error are part of
   * the honest delivery record, so the inspect includes both. The
   * delivery must belong to the named endpoint, so cross-endpoint,
   * foreign, and unknown ids all answer the same uniform 404, and
   * reads never write audit rows.
   */
  async inspectEndpointDelivery(
    userId: string,
    organizationId: string,
    endpointId: string,
    deliveryId: string,
  ) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.allRoles());
    return this.inspectEndpointDeliveryCore(organizationId, endpointId, deliveryId);
  }

  /**
   * Key-authenticated single delivery inspection, mirroring the JWT
   * route exactly through the shared core: the payload and the
   * recorded error stay part of the honest delivery record, and the
   * delivery must belong to the named endpoint. Reads never write
   * audit rows.
   */
  async inspectEndpointDeliveryForKey(
    key: AuthenticatedApiKey,
    endpointId: string,
    deliveryId: string,
  ) {
    return this.inspectEndpointDeliveryCore(key.organizationId, endpointId, deliveryId);
  }

  private async inspectEndpointDeliveryCore(
    organizationId: string,
    endpointId: string,
    deliveryId: string,
  ) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, organizationId },
      select: { id: true },
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found.');
    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, endpointId },
      select: { ...DELIVERY_SELECT, payload: true },
    });
    if (!delivery) throw new NotFoundException('Webhook delivery not found.');
    return delivery;
  }

  /**
   * Key-authenticated dispatch, grounded in the GitHub repository
   * dispatch event (POST /repos/{owner}/{repo}/dispatches behind the
   * Contents write permission): a machine identity with write access
   * triggers webhook deliveries straight from a token. The keyed
   * dispatch mirrors the JWT dispatch exactly - the same event-name
   * validation, the same subscription matching, the same honest zero
   * for no matching endpoints, and the same synchronous signed
   * attempts - tenant-bounded to the key organization, and the audit
   * row is stamped via genapi with the acting key so the trail shows
   * which key dispatched. Refusals never write audit rows.
   */
  async dispatchForKey(key: AuthenticatedApiKey, dto: DispatchEventDto) {
    const validated = validateEventName(dto.eventName);
    if (!validated.ok) {
      throw new BadRequestException('Unknown event name: ' + dto.eventName);
    }

    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { organizationId: key.organizationId, active: true },
    });
    const matching = endpoints.filter((endpoint) =>
      matchesSubscriptions(endpoint.eventSubscriptions, dto.eventName),
    );

    const results = [];
    for (const endpoint of matching) {
      const delivery = await this.createDeliveryForEndpoint(
        endpoint.id,
        key.organizationId,
        dto.eventName,
        (dto.payload ?? {}) as Prisma.InputJsonValue,
      );
      if (!delivery) {
        continue;
      }
      const outcome = await this.attemptDelivery(delivery.id);
      results.push(outcome ?? {
        deliveryId: delivery.id,
        endpointId: endpoint.id,
        status: delivery.status,
        attempts: delivery.attempts,
        lastStatusCode: null,
        lastError: 'attempt already in progress',
      });
    }

    const actor = keyActorFromApiKey(key);
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: actor.attributedUserId,
        organizationId: key.organizationId,
        action: 'webhook.dispatch',
        resourceType: 'webhook_delivery',
        resourceId: dto.eventName,
        outcome: 'SUCCESS',
        metadata: actorAuditMetadata(actor, {
          eventName: dto.eventName,
          matchedEndpoints: matching.length,
        }),
      },
    });

    return {
      eventName: dto.eventName,
      matchedEndpoints: matching.length,
      deliveries: results,
    };
  }

  /**
   * Key-authenticated manual retry, grounded in the GitHub webhook
   * redelivery (the POST attempts route behind admin access): a
   * redelivery is a write on the delivery record, never a read, and
   * keys are minted only by organization admins, so a WRITE_ORGANIZATION
   * key is an admin-delegated write exactly like the read delegation
   * on the audit trail. The keyed retry mirrors the JWT retry exactly -
   * the same backoff gate with the same honest 409s and the same atomic
   * PENDING-to-IN_FLIGHT claim so two racers can never double-send -
   * tenant-bounded to the key organization with one uniform 404, and
   * the audit row is stamped via genapi with the acting key. Refused
   * retries never write audit rows.
   */
  async retryForKey(key: AuthenticatedApiKey, deliveryId: string) {
    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, organizationId: key.organizationId },
      include: { endpoint: true },
    });
    if (!delivery || !delivery.endpoint) {
      throw new NotFoundException('Webhook delivery not found.');
    }

    const gate = canRetryNow({
      status: delivery.status,
      attempts: delivery.attempts,
      nextAttemptAt: delivery.nextAttemptAt,
      now: new Date(),
    });
    if (!gate.ok) {
      if (gate.reason === 'webhook-retry-too-early') {
        throw new ConflictException('Retry is not due yet.');
      }
      throw new ConflictException('No retries remain for this delivery.');
    }

    const outcome = await this.attemptDelivery(deliveryId);
    if (!outcome) {
      throw new ConflictException('Delivery is already being attempted.');
    }

    const actor = keyActorFromApiKey(key);
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: actor.attributedUserId,
        organizationId: key.organizationId,
        action: 'webhook.retry',
        resourceType: 'webhook_delivery',
        resourceId: deliveryId,
        outcome: 'SUCCESS',
        metadata: actorAuditMetadata(actor, {
          status: outcome.status,
          attempts: outcome.attempts,
        }),
      },
    });
    return outcome;
  }
  /**
   * System emission - the outbox law: emission happens AFTER the parent
   * operation has committed, is best-effort, and can NEVER fail or roll
   * back the parent flow. Delivery failures are recorded on the delivery
   * row (where the retry route can reach them), never thrown. There is
   * no audit row here: the parent action already audits itself, and the
   * delivery rows are the evidence of what was sent.
   */
  async emitSystemEvent(input: {
    organizationId: string;
    eventName: string;
    payload: Record<string, unknown>;
  }): Promise<{ emitted: boolean; matchedEndpoints: number; reason?: string }> {
    try {
      const validated = buildSystemPayload(input.eventName, input.payload);
      if (!validated.ok) {
        return { emitted: false, matchedEndpoints: 0, reason: validated.reason };
      }
      const endpoints = await this.prisma.webhookEndpoint.findMany({
        where: { organizationId: input.organizationId, active: true },
      });
      const matching = endpoints.filter((endpoint) =>
        matchesSubscriptions(endpoint.eventSubscriptions, input.eventName),
      );
      for (const endpoint of matching) {
        const delivery = await this.createDeliveryForEndpoint(
          endpoint.id,
          input.organizationId,
          input.eventName,
          validated.value as Prisma.InputJsonValue,
        );
        if (!delivery) {
          continue;
        }
        await this.attemptDelivery(delivery.id);
      }
      return { emitted: true, matchedEndpoints: matching.length };
    } catch {
      return { emitted: false, matchedEndpoints: 0, reason: 'system-event-emission-failed' };
    }
  }

  /** Emits a system event for an application, resolving its organization. */
  async emitForApplication(
    applicationId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<{ emitted: boolean; matchedEndpoints: number; reason?: string }> {
    try {
      const application = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: { project: { select: { workspace: { select: { organizationId: true } } } } },
      });
      if (!application) {
        return { emitted: false, matchedEndpoints: 0, reason: 'system-event-application-not-found' };
      }
      return await this.emitSystemEvent({
        organizationId: application.project.workspace.organizationId,
        eventName,
        payload,
      });
    } catch {
      return { emitted: false, matchedEndpoints: 0, reason: 'system-event-emission-failed' };
    }
  }

  /** Emits a system event for a project, resolving its organization. */
  async emitForProject(
    projectId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<{ emitted: boolean; matchedEndpoints: number; reason?: string }> {
    try {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { workspace: { select: { organizationId: true } } },
      });
      if (!project) {
        return { emitted: false, matchedEndpoints: 0, reason: 'system-event-project-not-found' };
      }
      return await this.emitSystemEvent({
        organizationId: project.workspace.organizationId,
        eventName,
        payload,
      });
    } catch {
      return { emitted: false, matchedEndpoints: 0, reason: 'system-event-emission-failed' };
    }
  }

  /**
   * Creates one delivery row for a matching endpoint. An endpoint that
   * was deleted between the dispatch snapshot and this insert answers
   * null - deleting an endpoint immediately stops its deliveries, the
   * same law GitHub and Stripe follow - instead of surfacing a
   * foreign-key 500 to the caller.
   */
  private async createDeliveryForEndpoint(
    endpointId: string,
    organizationId: string,
    eventName: string,
    payload: Prisma.InputJsonValue,
  ) {
    try {
      return await this.prisma.webhookDelivery.create({
        data: {
          endpointId,
          organizationId,
          eventName,
          payload,
          status: 'PENDING',
          attempts: 0,
        },
        select: DELIVERY_SELECT,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Performs one signed delivery attempt. The claim is an atomic
   * updateMany that flips PENDING to IN_FLIGHT: a concurrent claimant
   * re-evaluates the WHERE clause AFTER the winner commits, sees
   * IN_FLIGHT, and loses cleanly - regardless of whether it read
   * the row before or after the winner claimed. Exactly one caller
   * ever sends; everyone else sees null.
   */
  private async attemptDelivery(deliveryId: string) {
    const claim = await this.prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, status: 'PENDING' },
      data: { status: 'IN_FLIGHT', attempts: { increment: 1 } },
    });
    if (claim.count !== 1) return null;

    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { endpoint: true },
    });
    if (!delivery || !delivery.endpoint) return null;

    const sentAt = new Date();
    const body = JSON.stringify({
      event: delivery.eventName,
      payload: delivery.payload,
      deliveryId: delivery.id,
      sentAt: sentAt.toISOString(),
    });
    const header = signPayload(
      delivery.endpoint.secret,
      Math.floor(sentAt.getTime() / 1000),
      body,
    );

    let ok = false;
    let statusCode: number | null = null;
    let errorDetail: string | null = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
    try {
      const response = await fetch(delivery.endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: header,
        },
        body,
        signal: controller.signal,
      });
      statusCode = response.status;
      ok = response.ok;
      if (!ok) {
        errorDetail = 'Remote answered with HTTP ' + response.status + '.';
      }
    } catch (error) {
      const cause = (error as { cause?: { message?: string } }).cause?.message;
      const direct = (error as Error).message;
      errorDetail = String(cause ?? direct ?? error).slice(0, 300);
    } finally {
      clearTimeout(timer);
    }

    const status = nextDeliveryStatus(ok, delivery.attempts);
    const nextAttemptAt =
      status === 'PENDING' ? new Date(Date.now() + backoffSeconds(delivery.attempts) * 1000) : null;

    // An endpoint delete can cascade this delivery row away mid-attempt.
    // The attempt itself still happened, so the final write is a
    // conditional updateMany that quietly matches zero rows instead of
    // surfacing a record-missing P2025 as a 500.
    await this.prisma.webhookDelivery.updateMany({
      where: { id: delivery.id },
      data: {
        status,
        lastStatusCode: statusCode,
        lastError: ok ? null : errorDetail,
        deliveredAt: ok ? new Date() : null,
        nextAttemptAt,
      },
    });

    if (ok) {
      await this.prisma.webhookEndpoint
        .update({ where: { id: delivery.endpoint.id }, data: { lastSuccessAt: new Date() } })
        .catch(() => undefined);
    } else {
      await this.prisma.webhookEndpoint
        .update({ where: { id: delivery.endpoint.id }, data: { lastFailureAt: new Date() } })
        .catch(() => undefined);
    }

    return {
      deliveryId: delivery.id,
      endpointId: delivery.endpoint.id,
      status,
      attempts: delivery.attempts,
      lastStatusCode: statusCode,
      lastError: ok ? null : errorDetail,
    };
  }
}
