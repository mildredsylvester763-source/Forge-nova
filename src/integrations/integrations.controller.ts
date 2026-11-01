import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateConnectionDto } from './dto/create-connection.dto';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { DispatchEventDto } from './dto/dispatch-event.dto';
import { IntegrationService } from './integration.service';
import { UpdateWebhookEndpointDto } from './dto/update-webhook-endpoint.dto';
import { WebhookService } from './webhook.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

/**
 * The integration/connector platform surface. Role gates mirror the
 * API-key conventions: reads for all roles, writes for admins.
 */
@Controller('organizations/:organizationId/integrations')
@UseGuards(JwtAuthGuard)
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationService,
  ) {}

  @Get('connectors')
  connectors(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
  ) {
    return this.integrations.listCatalog(request.user.sub, organizationId);
  }

  @Post('connections')
  createConnection(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Body() dto: CreateConnectionDto,
  ) {
    return this.integrations.create(request.user.sub, organizationId, dto);
  }

  @Get('connections')
  listConnections(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
  ) {
    return this.integrations.list(request.user.sub, organizationId);
  }

  @Post('connections/:connectionId/test')
  testConnection(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Param('connectionId') connectionId: string,
  ) {
    return this.integrations.testConnection(request.user.sub, organizationId, connectionId);
  }

  @Delete('connections/:connectionId')
  removeConnection(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Param('connectionId') connectionId: string,
  ) {
    return this.integrations.remove(request.user.sub, organizationId, connectionId);
  }
}

/**
 * Webhook endpoints and delivery operations. Dispatch and retry are
 * write-role operations; endpoint lifecycle is admin-only.
 */
@Controller('organizations/:organizationId/webhooks')
@UseGuards(JwtAuthGuard)
export class WebhooksController {
  constructor(private readonly webhooks: WebhookService) {}

  @Post('endpoints')
  createEndpoint(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Body() dto: CreateWebhookEndpointDto,
  ) {
    return this.webhooks.createEndpoint(request.user.sub, organizationId, dto);
  }

  @Get('endpoints')
  listEndpoints(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
  ) {
    return this.webhooks.listEndpoints(request.user.sub, organizationId);
  }

  @Delete('endpoints/:endpointId')
  removeEndpoint(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Param('endpointId') endpointId: string,
  ) {
    return this.webhooks.removeEndpoint(request.user.sub, organizationId, endpointId);
  }

  /**
   * Endpoint update. Grounded in the GitHub webhook update, which
   * needs the Webhooks write permission, and the Stripe webhook
   * endpoint update: a PATCH is a partial write - only the fields
   * sent change and everything else stays untouched. The signing
   * secret is never updatable, an empty body is an honest no-op,
   * and foreign and unknown endpoints answer the same uniform 404
   * as the delete route.
   */
  @Patch('endpoints/:endpointId')
  updateEndpoint(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Param('endpointId') endpointId: string,
    @Body() dto: UpdateWebhookEndpointDto,
  ) {
    return this.webhooks.updateEndpoint(request.user.sub, organizationId, endpointId, dto);
  }

  /**
   * Ping. Grounded in the GitHub org webhook ping, which needs the
   * Webhooks write permission and pushes one ping event to the
   * endpoint as a confirmation that it is configured and reachable:
   * a ping goes to the named endpoint regardless of subscriptions
   * and regardless of the active flag, lands exactly one honest
   * delivery row with one signed attempt, and answers with the same
   * attempt shape as dispatch and retry. Unknown and foreign
   * endpoints answer the same uniform 404 as the other endpoint
   * routes.
   */
  @Post('endpoints/:endpointId/ping')
  pingEndpoint(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Param('endpointId') endpointId: string,
  ) {
    return this.webhooks.pingEndpoint(request.user.sub, organizationId, endpointId);
  }

  /**
   * Signing-secret rotation. Grounded in the market-wide law that a
   * leaked webhook secret must be replaceable without deleting the
   * endpoint: GitHub rotates through the update config.secret and
   * the industry pattern for reveal-once secret stores is a dedicated
   * rotate route that returns the raw secret exactly once - every
   * other surface stays secret-blind, the previous secret is
   * invalidated immediately, and unknown, foreign, and concurrently
   * deleted endpoints answer the same uniform 404 as the other
   * endpoint routes.
   */
  @Post('endpoints/:endpointId/rotate-secret')
  rotateEndpointSecret(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Param('endpointId') endpointId: string,
  ) {
    return this.webhooks.rotateEndpointSecret(request.user.sub, organizationId, endpointId);
  }
  @Post('dispatch')
  dispatch(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Body() dto: DispatchEventDto,
  ) {
    return this.webhooks.dispatch(request.user.sub, organizationId, dto);
  }

  @Get('deliveries')
  deliveries(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
  ) {
    return this.webhooks.listDeliveries(request.user.sub, organizationId);
  }

  @Post('deliveries/:deliveryId/retry')
  retry(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Param('deliveryId') deliveryId: string,
  ) {
    return this.webhooks.retry(request.user.sub, organizationId, deliveryId);
  }

  /**
   * Per-endpoint delivery history. Grounded in the GitHub hook
   * deliveries listing: reading delivery history needs only read
   * permission, the rows come back newest first capped at 100 like
   * the GitHub per_page maximum, and the optional status filter is
   * a real predicate - unknown, case-mangled, and padded values are
   * refused by name, never silently ignored. Foreign,
   * cross-organization, and unknown endpoint ids all answer one
   * uniform 404, and there is deliberately no audit row for reads.
   */
  @Get('endpoints/:endpointId/deliveries')
  endpointDeliveries(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Param('endpointId') endpointId: string,
    @Query('status') status?: string,
  ) {
    return this.webhooks.listEndpointDeliveries(request.user.sub, organizationId, endpointId, status);
  }

  /**
   * Single delivery inspection. Grounded in the GitHub single
   * delivery read: the payload and the recorded error are part of
   * the honest delivery record, so the inspect includes both. The
   * delivery must belong to the named endpoint, so cross-endpoint,
   * foreign, and unknown ids all answer one uniform 404, and there
   * is deliberately no audit row for reads.
   */
  @Get('endpoints/:endpointId/deliveries/:deliveryId')
  inspectEndpointDelivery(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Param('endpointId') endpointId: string,
    @Param('deliveryId') deliveryId: string,
  ) {
    return this.webhooks.inspectEndpointDelivery(
      request.user.sub,
      organizationId,
      endpointId,
      deliveryId,
    );
  }
}
