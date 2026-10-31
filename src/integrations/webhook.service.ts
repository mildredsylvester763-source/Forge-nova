import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { DispatchEventDto } from './dto/dispatch-event.dto';
import { backoffSeconds, canRetryNow, nextDeliveryStatus } from './engine/delivery-backoff.engine';
import { matchesSubscriptions, validateEventName, validateSubscription } from './engine/event-subscription.engine';
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
      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          organizationId,
          eventName: dto.eventName,
          payload: (dto.payload ?? {}) as Prisma.InputJsonValue,
          status: 'PENDING',
          attempts: 0,
        },
        select: DELIVERY_SELECT,
      });
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

    await this.prisma.webhookDelivery.update({
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
