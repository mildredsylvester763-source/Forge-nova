import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ApplicationService } from '../applications/application.service';
import { UpdateApplicationDto } from '../applications/dto/update-application.dto';
import { CreateApplicationDto } from '../applications/dto/create-application.dto';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { CreateCheckpointDto } from '../checkpoints/dto/create-checkpoint.dto';
import { FileService } from '../files/file.service';
import { WriteFileDto } from '../files/dto/write-file.dto';
import { VerificationService } from '../verification/verification.service';
import { ConversationService } from '../conversations/conversation.service';
import { CreateMessageDto } from '../conversations/dto/create-message.dto';
import { ReferencesService } from '../references/references.service';
import { JobQueueService } from '../execution/job-queue.service';
import { WorkGraphService } from '../work-graphs/work-graph.service';
import { DeploymentService } from '../deployments/deployment.service';
import { OrganizationService } from '../organizations/organization.service';
import { WorkspaceService } from '../workspaces/workspace.service';
import { ProjectService } from '../projects/project.service';
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
    private readonly conversations: ConversationService,
    private readonly references: ReferencesService,
    private readonly deployments: DeploymentService,
    private readonly organizations: OrganizationService,
    private readonly workspaces: WorkspaceService,
    private readonly projectService: ProjectService,
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

  /**
   * Key-authenticated organization audit trail. Grounded in the GitHub
   * audit log REST surface, where reading audit data needs a dedicated
   * read permission and the trail comes back newest first: the listing
   * mirrors the JWT admin surface exactly, tenant-bounded to the key
   * organization. There is deliberately no audit row for reads.
   */
  @Get('audit-events')
  @RequireScopes('READ_ORGANIZATION')
  listAuditEvents(@Req() request: KeyedRequest) {
    return this.organizations.listAuditEventsForKey(request.apiKey!);
  }

  /**
   * Key-authenticated workspace listing. Grounded in the GitHub team
   * listing: organization grouping structures are readable with the
   * organization-level read permission, and the rows mirror the JWT
   * workspace listing exactly so the two surfaces can never drift
   * apart. The listing is bounded to the key organization and reads
   * never audit.
   */
  @Get('workspaces')
  @RequireScopes('READ_ORGANIZATION')
  listWorkspaces(@Req() request: KeyedRequest) {
    return this.workspaces.listForKey(request.apiKey!);
  }

  /**
   * Key-authenticated project listing inside one workspace. Grounded in
   * the GitHub project listing: the Projects read permission is enough,
   * and a workspace outside the key organization answers the same
   * uniform 404 as an unknown one, so the surface never leaks what
   * exists in other tenants.
   */
  @Get('workspaces/:workspaceId/projects')
  @RequireScopes('READ_PROJECTS')
  listWorkspaceProjects(
    @Req() request: KeyedRequest,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.projectService.listInWorkspaceForKey(request.apiKey!, workspaceId);
  }

  /**
   * Key-authenticated project inspection. Grounded in the GitHub
   * single-project read: the Projects read permission is enough, the
   * shape mirrors the JWT inspection exactly (nested applications
   * included), and foreign, unknown, and deleted projects all answer
   * one uniform 404.
   */
  @Get('projects/:projectId')
  @RequireScopes('READ_PROJECTS')
  inspectProject(
    @Req() request: KeyedRequest,
    @Param('projectId') projectId: string,
  ) {
    return this.projectService.getForKey(request.apiKey!, projectId);
  }

  /**
   * Key-authenticated application create. Grounded in the market
   * leaders: GitHub organization repositories are created by tokens
   * inside a specified organization, and Vercel projects are created
   * by a Bearer token with only the name required. WRITE_APPLICATIONS
   * grants the create; the writable tenant bound refuses foreign,
   * missing, and archived projects with one uniform 404; the create
   * lands in the audit trail exactly once, attributed to the acting
   * key; and the application.created event reaches project webhook
   * endpoints exactly like the JWT create.
   */
  @Post('projects/:projectId/applications')
  @RequireScopes('WRITE_APPLICATIONS')
  createApplicationInProject(
    @Req() request: KeyedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: CreateApplicationDto,
  ) {
    return this.apps.createForKey(request.apiKey!, projectId, dto);
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

  /**
   * Key-authenticated job listing. The shape and the newest-first order
   * mirror the JWT listing route exactly, so the two surfaces can never
   * drift apart. Grounded in the GitHub workflow-run listing: reading
   * needs only read access and unknown status filters are refused by
   * name. There is deliberately no audit row for reads.
   */
  @Get('applications/:applicationId/jobs')
  @RequireScopes('READ_APPLICATIONS')
  listJobs(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Query('status') status?: string,
  ) {
    return this.jobs.listForKey(request.apiKey!, applicationId, status);
  }

  /**
   * Key-authenticated conversation listing, mirroring the JWT shape
   * exactly (newest activity first, honest message counts). Grounded in
   * the GitHub issue-comment listing: reading needs only read access,
   * and there is no audit row for reads.
   */
  @Get('applications/:applicationId/conversations')
  @RequireScopes('READ_APPLICATIONS')
  listConversations(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.conversations.listForKey(request.apiKey!, applicationId);
  }

  /**
   * Key-authenticated message listing with the same window law as the
   * JWT route: take 1-100 validated by the shared parse law, an optional
   * before cursor, and messages returned oldest-first like GitHub issue
   * comments. The conversation must belong to the named application, so
   * cross-application, foreign, and unknown ids all answer one uniform
   * 404 that never leaks what exists.
   */
  @Get('applications/:applicationId/conversations/:conversationId/messages')
  @RequireScopes('READ_APPLICATIONS')
  listConversationMessages(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('conversationId') conversationId: string,
    @Query('take') take?: string,
    @Query('before') before?: string,
  ) {
    return this.conversations.listMessagesForKey(
      request.apiKey!,
      applicationId,
      conversationId,
      take,
      before,
    );
  }

  /**
   * Key-authenticated user message write. Grounded in the GitHub issue
   * comment create: a token with write permission may post comments and
   * the post is attributed to the token identity. The application
   * tenant bound refuses foreign and archived applications, the
   * conversation must belong to that application, and the archived
   * conversation law mirrors the JWT route exactly.
   */
  @Post('applications/:applicationId/conversations/:conversationId/messages')
  @RequireScopes('WRITE_APPLICATIONS')
  addConversationMessage(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: CreateMessageDto,
  ) {
    return this.conversations.addUserMessageForKey(
      request.apiKey!,
      applicationId,
      conversationId,
      dto,
    );
  }

  /**
   * Key-authenticated reference listing, mirroring the JWT shape exactly
   * (newest first, the honest window of 100, full documents included).
   */
  @Get('applications/:applicationId/references')
  @RequireScopes('READ_APPLICATIONS')
  listReferences(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.references.listForKey(request.apiKey!, applicationId);
  }

  /**
   * Key-authenticated reference inspect. Foreign, cross-application, and
   * missing references all answer the same uniform 404 as the JWT route.
   */
  @Get('applications/:applicationId/references/:referenceId')
  @RequireScopes('READ_APPLICATIONS')
  inspectReference(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('referenceId') referenceId: string,
  ) {
    return this.references.getForKey(request.apiKey!, applicationId, referenceId);
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

  /**
   * Key-authenticated readiness report. Grounded in the GitHub
   * deployments read surface: reading deployments and their statuses
   * needs only read access. Reads stay possible on archived
   * applications and never write an audit row.
   */
  @Get('applications/:applicationId/deployments/readiness')
  @RequireScopes('READ_APPLICATIONS')
  readDeploymentReadiness(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.deployments.getReadinessForKey(request.apiKey!, applicationId);
  }

  /**
   * Key-authenticated deployment listing, mirroring the JWT shape
   * exactly: newest first, capped at 50, never padded.
   */
  @Get('applications/:applicationId/deployments')
  @RequireScopes('READ_APPLICATIONS')
  listDeployments(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.deployments.listForKey(request.apiKey!, applicationId);
  }

  /**
   * Key-authenticated deployment inspect. Cross-application, foreign,
   * and unknown deployments all answer the same uniform 404 as the JWT
   * route, so the surface never leaks what exists.
   */
  @Get('applications/:applicationId/deployments/:deploymentId')
  @RequireScopes('READ_APPLICATIONS')
  inspectDeployment(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('deploymentId') deploymentId: string,
  ) {
    return this.deployments.getForKey(request.apiKey!, applicationId, deploymentId);
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
   * Key-authenticated application update. Grounded in the market
   * leaders: GitHub repository updates and Vercel project updates are
   * partial metadata writes by id behind write permission, never read.
   * The keyed update mirrors the JWT update exactly - same four
   * optional fields, same honest audit row, same application.updated
   * event - with the acting key attributed in the trail, and the
   * writable tenant bound refuses foreign, missing, and archived
   * applications with one uniform 404.
   */
  @Post('applications/:applicationId/update')
  @RequireScopes('WRITE_APPLICATIONS')
  updateApplication(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: UpdateApplicationDto,
  ) {
    return this.apps.updateForKey(request.apiKey!, applicationId, dto);
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
