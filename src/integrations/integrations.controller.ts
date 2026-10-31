import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateConnectionDto } from './dto/create-connection.dto';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { DispatchEventDto } from './dto/dispatch-event.dto';
import { IntegrationService } from './integration.service';
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
}
