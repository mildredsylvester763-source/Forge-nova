import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ApiKeyGuard, AuthenticatedApiKey, RequireScopes } from './api-key.guard';
import { ApiKeyService } from './api-key.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };
type KeyedRequest = Request & { apiKey?: AuthenticatedApiKey };

@Controller('organizations/:organizationId/api-keys')
@UseGuards(JwtAuthGuard)
export class ApiKeyAdminController {
  constructor(private readonly apiKeys: ApiKeyService) {}

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Body() dto: CreateApiKeyDto,
  ) {
    return this.apiKeys.create(request.user.sub, organizationId, dto);
  }

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
  ) {
    return this.apiKeys.list(request.user.sub, organizationId);
  }

  @Post(':keyId/revoke')
  revoke(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Param('keyId') keyId: string,
  ) {
    return this.apiKeys.revoke(request.user.sub, organizationId, keyId);
  }
}

/**
 * The key-authenticated GENESIS API surface. Every route is tenant-
 * bounded to the key's own organization and gated by a concrete scope.
 */
@Controller('genapi')
@UseGuards(ApiKeyGuard)
export class GenapiController {
  constructor(private readonly apiKeys: ApiKeyService) {}

  @Get('me')
  @RequireScopes('READ_ORGANIZATION')
  me(@Req() request: KeyedRequest) {
    const key = request.apiKey!;
    return {
      key: { id: key.id, name: key.name, scopes: key.scopes },
      organization: { id: key.organizationId },
    };
  }

  @Get('projects')
  @RequireScopes('READ_PROJECTS')
  projects(@Req() request: KeyedRequest) {
    return this.apiKeys.listOrganizationProjects(request.apiKey!.organizationId);
  }

  @Get('applications')
  @RequireScopes('READ_APPLICATIONS')
  applications(@Req() request: KeyedRequest) {
    return this.apiKeys.listOrganizationApplications(request.apiKey!.organizationId);
  }
}
