import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ApplicationService } from '../applications/application.service';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { CreateCheckpointDto } from '../checkpoints/dto/create-checkpoint.dto';
import { FileService } from '../files/file.service';
import { WriteFileDto } from '../files/dto/write-file.dto';
import { VerificationService } from '../verification/verification.service';
import { JobQueueService } from '../execution/job-queue.service';
import { WorkGraphService } from '../work-graphs/work-graph.service';
import { RunVerificationDto } from '../verification/dto/run-verification.dto';
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
 * bounded to the organization the key belongs to and gated by a concrete scope.
 * The WRITE_APPLICATIONS scope is honored by real write endpoints
 * below; it exists nowhere else.
 */
@Controller('genapi')
@UseGuards(ApiKeyGuard)
export class GenapiController {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly files: FileService,
    private readonly checkpoints: CheckpointService,
    private readonly verifications: VerificationService,
    private readonly apps: ApplicationService,
    private readonly jobs: JobQueueService,
    private readonly graphs: WorkGraphService,
  ) {}

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

  @Get('applications/:applicationId/files')
  @RequireScopes('READ_APPLICATIONS')
  listFiles(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.files.listForKey(request.apiKey!, applicationId);
  }

  @Get('applications/:applicationId/files/:fileId')
  @RequireScopes('READ_APPLICATIONS')
  readFile(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('fileId') fileId: string,
  ) {
    return this.files.readForKey(request.apiKey!, applicationId, fileId);
  }

  @Get('applications/:applicationId/checkpoints')
  @RequireScopes('READ_APPLICATIONS')
  listCheckpoints(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.checkpoints.listForKey(request.apiKey!, applicationId);
  }

  @Get('applications/:applicationId/verifications')
  @RequireScopes('READ_APPLICATIONS')
  listVerifications(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.verifications.listForApplicationForKey(request.apiKey!, applicationId);
  }

  @Get('applications/:applicationId/verifications/:verificationId')
  @RequireScopes('READ_APPLICATIONS')
  inspectVerification(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('verificationId') verificationId: string,
  ) {
    return this.verifications.findOneForKey(request.apiKey!, applicationId, verificationId);
  }

  @Get('applications/:applicationId/work-graphs')
  @RequireScopes('READ_APPLICATIONS')
  listWorkGraphs(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.graphs.listForKey(request.apiKey!, applicationId);
  }

  @Get('applications/:applicationId/work-graphs/:graphId')
  @RequireScopes('READ_APPLICATIONS')
  readWorkGraph(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('graphId') graphId: string,
  ) {
    return this.graphs.getForKey(request.apiKey!, applicationId, graphId);
  }

  @Get('applications/:applicationId/work-graphs/:graphId/validate')
  @RequireScopes('READ_APPLICATIONS')
  validateWorkGraph(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('graphId') graphId: string,
  ) {
    return this.graphs.validateForKey(request.apiKey!, applicationId, graphId);
  }

  @Get('applications/:applicationId/jobs/:jobId')
  @RequireScopes('READ_APPLICATIONS')
  inspectJob(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.jobs.getForKey(request.apiKey!, applicationId, jobId);
  }

  @Post('applications/:applicationId/files')
  @RequireScopes('WRITE_APPLICATIONS')
  writeFile(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: WriteFileDto,
  ) {
    return this.files.writeForKey(request.apiKey!, applicationId, dto);
  }

  @Post('applications/:applicationId/checkpoints')
  @RequireScopes('WRITE_APPLICATIONS')
  createCheckpoint(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: CreateCheckpointDto,
  ) {
    return this.checkpoints.createForKey(request.apiKey!, applicationId, dto.label);
  }

  @Post('applications/:applicationId/checkpoints/:checkpointId/restore')
  @RequireScopes('WRITE_APPLICATIONS')
  restoreCheckpoint(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('checkpointId') checkpointId: string,
  ) {
    return this.checkpoints.restoreForKey(request.apiKey!, applicationId, checkpointId);
  }

  @Post('applications/:applicationId/verifications')
  @RequireScopes('WRITE_APPLICATIONS')
  runVerifications(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto?: RunVerificationDto,
  ) {
    return this.verifications.runForApplicationForKey(request.apiKey!, applicationId, dto?.kinds);
  }

  @Post('applications/:applicationId/archive')
  @RequireScopes('WRITE_APPLICATIONS')
  archiveApplication(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.apps.archiveForKey(request.apiKey!, applicationId);
  }

  @Post('applications/:applicationId/restore')
  @RequireScopes('WRITE_APPLICATIONS')
  restoreApplication(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.apps.restoreForKey(request.apiKey!, applicationId);
  }

  /**
   * Key-authenticated job cancellation. Mirrors the semantics GitHub
   * gives workflow-run cancellation: write access is required, only
   * queued or in-progress jobs can be cancelled, and cancelling an
   * already finished job is an honest no-op that reports the current
   * status. The state change lands in the organization audit trail
   * exactly once, attributed to the acting key.
   */
  @Post('applications/:applicationId/jobs/:jobId/cancel')
  @RequireScopes('WRITE_APPLICATIONS')
  cancelJob(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.jobs.cancelForKey(request.apiKey!, applicationId, jobId);
  }
}
