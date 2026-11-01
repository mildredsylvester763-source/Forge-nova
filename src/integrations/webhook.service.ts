import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { DispatchEventDto } from './dto/dispatch-event.dto';
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
            actorUserId: userId,
            organizationId,
            action: 'webhook.endpoint.create',
            resourceType: 'webhook_endpoint',
            resourceId: endpoint.id,
            outcome: 'SUCCESS',
            metadata: { url: dto.url, eventSubscriptions: subscriptions },
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
    return this.prisma.webhookEndpoint.findMany({
      where: { organizationId },
      select: ENDPOINT_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Guarded delete: racing deletes get one 200 and one 404. */
  async removeEndpoint(userId: string, organizationId: string, endpointId: string) {
    await this.access.requireOrganizationRole(userId, organizationId, this.access.adminRoles());
    const deleted = await this.prisma.$transaction(async (tx) => {
      const result = await tx.webhookEndpoint.deleteMany({
        where: { id: endpointId, organizationId },
      });
      if (result.count !== 1) return false;
      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          organizationId,
          action: 'webhook.endpoint.delete',
          resourceType: 'webhook_endpoint',
          resourceId: endpointId,
          outcome: 'SUCCESS',
          metadata: {},
        },
      });
      return true;
    });
    if (!deleted) throw new NotFoundException('Webhook endpoint not found.');
    return { deleted: true, endpointId };
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
