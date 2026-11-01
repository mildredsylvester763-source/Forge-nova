import { Body, ConflictException, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JobType } from '@prisma/client';
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
import { RestoreFileDto } from '../files/dto/restore-file.dto';
import { VerificationService } from '../verification/verification.service';
import { ConversationService } from '../conversations/conversation.service';
import { CreateMessageDto } from '../conversations/dto/create-message.dto';
import { CreateConversationDto } from '../conversations/dto/create-conversation.dto';
import { CreateReferenceDto } from '../references/dto/create-reference.dto';
import { ReferencesService } from '../references/references.service';
import { JobQueueService } from '../execution/job-queue.service';
import { WorkGraphService } from '../work-graphs/work-graph.service';
import { CreateWorkGraphDto } from '../work-graphs/dto/create-work-graph.dto';
import { CreateWorkNodeDto } from '../work-graphs/dto/create-work-node.dto';
import { DeploymentService } from '../deployments/deployment.service';
import { CreateDeploymentDto } from '../deployments/dto/create-deployment.dto';
import { OrganizationService } from '../organizations/organization.service';
import { AddMemberDto } from '../organizations/dto/add-member.dto';
import { ChangeMemberRoleDto } from '../organizations/dto/change-member-role.dto';
import { TransferOwnershipDto } from '../organizations/dto/transfer-ownership.dto';
import { WebhookService } from '../integrations/webhook.service';
import { CreateWebhookEndpointDto } from '../integrations/dto/create-webhook-endpoint.dto';
import { DispatchEventDto } from '../integrations/dto/dispatch-event.dto';
import { UpdateWebhookEndpointDto } from '../integrations/dto/update-webhook-endpoint.dto';
import { IntegrationService } from '../integrations/integration.service';
import { CreateConnectionDto } from '../integrations/dto/create-connection.dto';
import { WorkspaceService } from '../workspaces/workspace.service';
import { CreateWorkspaceDto } from '../workspaces/dto/create-workspace.dto';
import { UpdateWorkspaceDto } from '../workspaces/dto/update-workspace.dto';
import { ProjectService } from '../projects/project.service';
import { CreateProjectDto } from '../projects/dto/create-project.dto';
import { UpdateProjectDto } from '../projects/dto/update-project.dto';
import { RunVerificationDto } from '../verification/dto/run-verification.dto';
import { GenerateSourceDto } from '../generation/dto/generate-source.dto';
import { ApiKeyGuard, AuthenticatedApiKey, RequireScopes } from './api-key.guard';
import { ApiKeyService } from './api-key.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { actorAttribution, keyActorFromApiKey } from './engine/api-key-policy';

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
 * The WRITE_APPLICATIONS, WRITE_ORGANIZATION, and WRITE_PROJECTS
 * scopes are honored by real write endpoints below; they exist nowhere
 * else.
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
    private readonly webhooks: WebhookService,
    private readonly integrations: IntegrationService,
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
   * Key-authenticated organization profile. Grounded in the GitHub
   * get-an-organization REST surface, where the profile read is a
   * first-class endpoint and a fine-grained token with organization
   * access reads the profile without any extra permissions: the
   * profile mirrors the organization fields of the JWT organization
   * listing exactly through the shared profile select, the key IS
   * the tenant bound so there is no path parameter to probe, and
   * reads never write audit rows.
   */
  @Get('organization')
  @RequireScopes('READ_ORGANIZATION')
  getOrganization(@Req() request: KeyedRequest) {
    return this.organizations.getOrganizationProfileForKey(request.apiKey!);
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
   * Key-authenticated organization member directory. Grounded in
   * the GitHub org members listing, where reading who belongs to
   * an organization needs only the Members organization read
   * permission: the rows mirror the JWT member listing exactly
   * through the shared core, the listing is bounded to the key
   * organization because the key IS the tenant bound, and reads
   * never write audit rows.
   */
  @Get('members')
  @RequireScopes('READ_ORGANIZATION')
  listMembers(@Req() request: KeyedRequest) {
    return this.organizations.listMembersForKey(request.apiKey!);
  }

  /**
   * Keyed member add. Grounded in the GitHub add-or-update organization
   * membership surface, where managing membership runs behind the
   * Members organization write permission and a token never grants
   * more access than its owner: keys are minted only by organization
   * admins, so a WRITE_ORGANIZATION key is an admin-delegated add
   * bounded to the key organization, the response mirrors the JWT
   * add exactly, and the landed add writes exactly one audit row
   * stamped via genapi with the acting key.
   */
  @Post('members')
  @RequireScopes('WRITE_ORGANIZATION')
  addMember(@Req() request: KeyedRequest, @Body() dto: AddMemberDto) {
    return this.organizations.addMemberForKey(request.apiKey!, dto);
  }

  /**
   * Keyed member role change. Grounded in the GitHub membership
   * update behind the Members organization write permission: the
   * policy engine decides exactly as for the JWT route, OWNER is
   * never assignable here, foreign and unknown membership ids
   * answer one uniform 404, and the landed change writes exactly
   * one audit row stamped via genapi with the acting key.
   */
  @Post('members/:membershipId/update')
  @RequireScopes('WRITE_ORGANIZATION')
  updateMemberRole(
    @Req() request: KeyedRequest,
    @Param('membershipId') membershipId: string,
    @Body() dto: ChangeMemberRoleDto,
  ) {
    return this.organizations.changeMemberRoleForKey(request.apiKey!, membershipId, dto);
  }

  /**
   * Keyed member removal. Grounded in the GitHub remove an
   * organization member surface behind the Members organization write
   * permission: the owner-protection policy decides exactly as for
   * the JWT route, the guarded delete hands racing removals exactly
   * one clean outcome, and the landed removal writes exactly one
   * audit row stamped via genapi with the acting key.
   */
  @Post('members/:membershipId/remove')
  @RequireScopes('WRITE_ORGANIZATION')
  removeMember(
    @Req() request: KeyedRequest,
    @Param('membershipId') membershipId: string,
  ) {
    return this.organizations.removeMemberForKey(request.apiKey!, membershipId);
  }

  /**
   * Keyed ownership transfer. Grounded in the GitHub organization
   * role assignment law - ownership changes are owner-only actions,
   * and a token never grants more access than its owner: the key
   * acts as its creator, so the transfer only runs while the
   * creator still holds OWNER in the key organization, with the
   * same gates, messages, and audit shape as the JWT route through
   * the one shared core.
   */
  @Post('ownership-transfer')
  @RequireScopes('WRITE_ORGANIZATION')
  transferOwnership(@Req() request: KeyedRequest, @Body() dto: TransferOwnershipDto) {
    return this.organizations.transferOwnershipForKey(request.apiKey!, dto);
  }

  /**
   * Key-authenticated key inventory. Grounded in the GitHub org
   * personal access token review surface, where organization owners
   * inspect the member token inventory with metadata only, while
   * Stripe keeps its key inventory dashboard-only: the rows mirror
   * the JWT admin listing exactly through the shared core, masked
   * hints only, and the listing is bounded to the key organization
   * because the key IS the tenant bound. Reads never write audit
   * rows.
   */
  @Get('api-keys')
  @RequireScopes('READ_ORGANIZATION')
  listApiKeys(@Req() request: KeyedRequest) {
    return this.apiKeys.listForKey(request.apiKey!);
  }

  /**
   * Key-authenticated webhook endpoint listing. Grounded in the
   * Stripe webhook endpoints REST surface, where the listing runs
   * with a restricted read key and an empty organization answers
   * an honest empty array instead of an error: webhook endpoints
   * are organization-level resources, so the organization read
   * scope governs the listing, the rows mirror the JWT surface
   * exactly through the shared core, and the signing secret
   * never appears in any read. Reads never write audit rows.
   */
  @Get('webhook-endpoints')
  @RequireScopes('READ_ORGANIZATION')
  listWebhookEndpoints(@Req() request: KeyedRequest) {
    return this.webhooks.listEndpointsForKey(request.apiKey!);
  }

  /**
   * Key-authenticated per-endpoint delivery history. Grounded in
   * the GitHub hook deliveries listing, where reading delivery
   * history needs only read permission: the same real status
   * predicate, the same newest-first capped-at-100 rows, and one
   * uniform 404 for foreign, cross-organization, and unknown
   * endpoint ids, exactly like the JWT route through the shared
   * core. Reads never write audit rows.
   */
  @Get('webhook-endpoints/:endpointId/deliveries')
  @RequireScopes('READ_ORGANIZATION')
  listWebhookEndpointDeliveries(
    @Req() request: KeyedRequest,
    @Param('endpointId') endpointId: string,
    @Query('status') status?: string,
  ) {
    return this.webhooks.listEndpointDeliveriesForKey(request.apiKey!, endpointId, status);
  }

  /**
   * Key-authenticated single delivery inspection. Grounded in the
   * GitHub single delivery read, where the payload and the
   * recorded error are part of the honest delivery record: the
   * delivery must belong to the named endpoint, so cross-endpoint
   * and unknown delivery ids answer one uniform 404, exactly like
   * the JWT route through the shared core. Reads never write
   * audit rows.
   */
  @Get('webhook-endpoints/:endpointId/deliveries/:deliveryId')
  @RequireScopes('READ_ORGANIZATION')
  inspectWebhookEndpointDelivery(
    @Req() request: KeyedRequest,
    @Param('endpointId') endpointId: string,
    @Param('deliveryId') deliveryId: string,
  ) {
    return this.webhooks.inspectEndpointDeliveryForKey(
      request.apiKey!,
      endpointId,
      deliveryId,
    );
  }

  /**
   * Keyed webhook dispatch, grounded in the GitHub repository dispatch
   * event (POST /repos/{owner}/{repo}/dispatches behind the Contents
   * write permission): a machine identity with write access triggers
   * webhook deliveries straight from a token. Keys are minted only by
   * organization admins, so a WRITE_ORGANIZATION key is an
   * admin-delegated write exactly like the read delegation on the
   * audit trail. The response mirrors the JWT dispatch shape and the
   * audit row is stamped via genapi with the acting key.
   */
  @Post('webhook-dispatches')
  @RequireScopes('WRITE_ORGANIZATION')
  dispatchWebhookEvent(@Req() request: KeyedRequest, @Body() dto: DispatchEventDto) {
    return this.webhooks.dispatchForKey(request.apiKey!, dto);
  }

  /**
   * Keyed delivery retry, grounded in the GitHub webhook redelivery
   * (the POST attempts route behind admin access): a redelivery is a
   * write on the delivery record. The same backoff gate, the same
   * honest 409s, the same atomic attempt claim as the JWT retry,
   * tenant-bounded to the key organization with one uniform 404, and
   * the audit row is stamped via genapi with the acting key.
   */
  @Post('webhook-deliveries/:deliveryId/retry')
  @RequireScopes('WRITE_ORGANIZATION')
  retryWebhookDelivery(@Req() request: KeyedRequest, @Param('deliveryId') deliveryId: string) {
    return this.webhooks.retryForKey(request.apiKey!, deliveryId);
  }

  /**
   * Keyed endpoint create, grounded in the Stripe webhook endpoint
   * create REST surface, where a write-capable key creates the
   * endpoint and the signing secret rides the create response
   * exactly once. Keys are minted only by organization admins, so a
   * WRITE_ORGANIZATION key is an admin-delegated write, and every
   * landed create writes exactly one audit row stamped via genapi.
   */
  @Post('webhook-endpoints')
  @RequireScopes('WRITE_ORGANIZATION')
  createWebhookEndpoint(@Req() request: KeyedRequest, @Body() dto: CreateWebhookEndpointDto) {
    return this.webhooks.createEndpointForKey(request.apiKey!, dto);
  }

  /**
   * Keyed endpoint partial update, grounded in the Stripe webhook
   * endpoint update and the GitHub webhook update behind the
   * Webhooks write permission: only the fields sent change, an empty
   * body is an honest no-op, and the secret is never updatable. The
   * keyed update mirrors the JWT PATCH exactly through the shared
   * core and every landed update writes exactly one audit row.
   */
  @Post('webhook-endpoints/:endpointId/update')
  @RequireScopes('WRITE_ORGANIZATION')
  updateWebhookEndpoint(
    @Req() request: KeyedRequest,
    @Param('endpointId') endpointId: string,
    @Body() dto: UpdateWebhookEndpointDto,
  ) {
    return this.webhooks.updateEndpointForKey(request.apiKey!, endpointId, dto);
  }

  /**
   * Keyed endpoint delete, grounded in the GitHub repo webhook
   * delete behind the Webhooks write permission: deleting an
   * endpoint immediately stops its deliveries, and racing deletes
   * get one 200 and one 404 through the shared guarded core. The
   * delete lands exactly one audit row stamped via genapi with the
   * acting key.
   */
  @Post('webhook-endpoints/:endpointId/delete')
  @RequireScopes('WRITE_ORGANIZATION')
  deleteWebhookEndpoint(
    @Req() request: KeyedRequest,
    @Param('endpointId') endpointId: string,
  ) {
    return this.webhooks.removeEndpointForKey(request.apiKey!, endpointId);
  }

  /**
   * Keyed endpoint ping, grounded in the GitHub org webhook ping
   * behind the Webhooks write permission: the ping is the
   * market-standard confirmation that an endpoint is configured
   * and reachable. One honest delivery row with one synchronous
   * signed attempt lands through the shared core, and every landed
   * ping writes exactly one audit row stamped via genapi.
   */
  @Post('webhook-endpoints/:endpointId/ping')
  @RequireScopes('WRITE_ORGANIZATION')
  pingWebhookEndpoint(
    @Req() request: KeyedRequest,
    @Param('endpointId') endpointId: string,
  ) {
    return this.webhooks.pingEndpointForKey(request.apiKey!, endpointId);
  }

  /**
   * Keyed signing-secret rotation, grounded in the GitHub secret
   * rotation through the update config.secret surface: keys are
   * minted only by organization admins, so a WRITE_ORGANIZATION key
   * is an admin-delegated rotation, and the fresh reveal-once
   * secret rides the rotation response exactly like the create
   * reveal. Every landed rotation writes exactly one audit row.
   */
  @Post('webhook-endpoints/:endpointId/rotate-secret')
  @RequireScopes('WRITE_ORGANIZATION')
  rotateWebhookEndpointSecret(
    @Req() request: KeyedRequest,
    @Param('endpointId') endpointId: string,
  ) {
    return this.webhooks.rotateEndpointSecretForKey(request.apiKey!, endpointId);
  }

  /**
   * Key-authenticated connector catalog. Grounded in the GitHub app
   * catalog read: the offer is metadata only - named connectors with
   * named credential fields - so the rows mirror the JWT catalog
   * exactly through the shared core. The key IS the tenant bound and
   * reads never write audit rows.
   */
  @Get('connectors')
  @RequireScopes('READ_ORGANIZATION')
  listConnectors(@Req() request: KeyedRequest) {
    return this.integrations.listCatalogForKey(request.apiKey!);
  }

  /**
   * Key-authenticated connection listing. Grounded in the GitHub
   * list-installations-for-an-organization read, which needs only
   * the organization administration read permission: the rows mirror
   * the JWT connection listing exactly through the shared core and
   * credential values never leave the vault. Reads never write
   * audit rows.
   */
  @Get('connections')
  @RequireScopes('READ_ORGANIZATION')
  listConnections(@Req() request: KeyedRequest) {
    return this.integrations.listForKey(request.apiKey!);
  }

  /**
   * Keyed connection create. Grounded in the GitHub app installation
   * create and the Vercel integration access token exchange: machine
   * identities create integration connections with scoped tokens, and
   * a token never grants more access than its owner. Keys are minted
   * only by organization admins, so a WRITE_ORGANIZATION key is an
   * admin-delegated create bounded to the key organization.
   * Credentials are validated against the catalog and echoed as
   * field names and lengths only, and the landed create writes
   * exactly one audit row stamped via genapi with the acting key.
   */
  @Post('connections')
  @RequireScopes('WRITE_ORGANIZATION')
  createConnection(@Req() request: KeyedRequest, @Body() dto: CreateConnectionDto) {
    return this.integrations.createForKey(request.apiKey!, dto);
  }

  /**
   * Keyed connection test. Grounded in the market verification law:
   * Vercel integration access tokens are verified by real requests,
   * and GitHub installation tokens carry honest installation
   * metadata. The keyed test performs the same REAL outbound request
   * with the same honest succeeded, failed, or unreachable outcome as
   * the JWT route, foreign and unknown ids answer one uniform 404,
   * and the audit row is stamped via genapi with the acting key.
   */
  @Post('connections/:connectionId/test')
  @RequireScopes('WRITE_ORGANIZATION')
  testConnection(
    @Req() request: KeyedRequest,
    @Param('connectionId') connectionId: string,
  ) {
    return this.integrations.testConnectionForKey(request.apiKey!, connectionId);
  }

  /**
   * Keyed connection delete. Grounded in the GitHub installation
   * removal behind organization administration write: a machine
   * identity with write access may remove the integration. Racing
   * deletes get exactly one 200 and one clean 404 through the shared
   * guarded core, and the landed delete writes exactly one audit row
   * stamped via genapi with the acting key.
   */
  @Post('connections/:connectionId/delete')
  @RequireScopes('WRITE_ORGANIZATION')
  deleteConnection(
    @Req() request: KeyedRequest,
    @Param('connectionId') connectionId: string,
  ) {
    return this.integrations.removeForKey(request.apiKey!, connectionId);
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
   * Key-authenticated workspace create. Grounded in the GitHub team
   * create REST surface: creating an organization grouping structure
   * needs the organization-level write permission, the team is
   * always created inside the organization the token belongs to, and
   * GitHub derives the team slug from the name server-side. Keys are
   * minted only by organization admins, so a WRITE_ORGANIZATION key
   * is an admin-delegated create, and a body organization other than
   * the key organization answers the same uniform 404 the JWT admin
   * gate gives for a foreign organization. There is no audit row
   * because the JWT create writes none.
   */
  @Post('workspaces')
  @RequireScopes('WRITE_ORGANIZATION')
  createWorkspace(@Req() request: KeyedRequest, @Body() dto: CreateWorkspaceDto) {
    return this.workspaces.createForKey(request.apiKey!, dto);
  }

  /**
   * Key-authenticated workspace rename. Grounded in the GitHub team
   * update behind the Members organization write permission: keys are
   * minted only by organization admins, so a WRITE_ORGANIZATION key is
   * an admin-delegated rename, a workspace outside the key
   * organization answers the same uniform 404 as an unknown one, the
   * name carries the same trim and length law as the create, and the
   * slug stays stable because it is the immutable server-derived
   * identifier. There is no audit row because the JWT rename writes
   * none.
   */
  @Post('workspaces/:workspaceId/update')
  @RequireScopes('WRITE_ORGANIZATION')
  updateWorkspace(
    @Req() request: KeyedRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdateWorkspaceDto,
  ) {
    return this.workspaces.updateForKey(request.apiKey!, workspaceId, dto);
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
   * Key-authenticated per-project application listing. Grounded in
   * the market leaders: the GitHub list-organization-repositories
   * surface lists child resources with nothing more than the base
   * read permission, and the OpenAI list-projects surface returns
   * the children of one organization as a flat array straight from
   * an API key. READ_APPLICATIONS governs the listing because the
   * rows are application rows; the readable tenant bound refuses
   * foreign, missing, and deleted projects with one uniform 404;
   * the rows mirror the JWT per-project listing exactly through the
   * shared core (newest activity first, archived applications
   * hidden); and reads never write audit rows.
   */
  @Get('projects/:projectId/applications')
  @RequireScopes('READ_APPLICATIONS')
  listProjectApplications(
    @Req() request: KeyedRequest,
    @Param('projectId') projectId: string,
  ) {
    return this.apps.listForProjectForKey(request.apiKey!, projectId);
  }

  /**
   * Key-authenticated project create. Grounded in the GitHub Projects
   * REST surface, where creating an organization project needs the
   * Projects write permission: the workspace must belong to the key
   * organization, the created row mirrors the JWT create exactly, and
   * the owner is the key creator because GitHub ties tokens to the
   * user who generated them. There is no audit row because the JWT
   * create writes none.
   */
  @Post('workspaces/:workspaceId/projects')
  @RequireScopes('WRITE_PROJECTS')
  createProject(
    @Req() request: KeyedRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateProjectDto,
  ) {
    return this.projectService.createForKey(request.apiKey!, workspaceId, dto);
  }

  /**
   * Key-authenticated project partial update. Grounded in the GitHub
   * project update behind the Projects write permission: only the
   * fields sent change, the writable tenant bound refuses foreign,
   * missing, and archived projects with one uniform 404, and there is
   * no audit row because the JWT update writes none.
   */
  @Post('projects/:projectId/update')
  @RequireScopes('WRITE_PROJECTS')
  updateProject(
    @Req() request: KeyedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectService.updateForKey(request.apiKey!, projectId, dto);
  }

  /**
   * Key-authenticated project archive. Grounded in the GitHub project
   * state update (open and closed) behind the Projects write
   * permission: the writable tenant bound refuses foreign, missing,
   * and already archived projects with one uniform 404, and there is
   * no audit row because the JWT archive writes none.
   */
  @Post('projects/:projectId/archive')
  @RequireScopes('WRITE_PROJECTS')
  archiveProject(
    @Req() request: KeyedRequest,
    @Param('projectId') projectId: string,
  ) {
    return this.projectService.archiveForKey(request.apiKey!, projectId);
  }

  /**
   * Key-authenticated project restore. Grounded in the GitHub project
   * reopen through the write surface: the archived project must live
   * in the key organization, the restore claim is atomic so racing
   * restores end exactly one way, and the landed restore writes
   * exactly one attributed audit row stamped via genapi.
   */
  @Post('projects/:projectId/restore')
  @RequireScopes('WRITE_PROJECTS')
  restoreProject(
    @Req() request: KeyedRequest,
    @Param('projectId') projectId: string,
  ) {
    return this.projectService.restoreForKey(request.apiKey!, projectId);
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
   * Key-authenticated work graph create. Grounded in the market
   * leaders: the Vercel project create builds a new resource straight
   * from a Bearer access token with only the name required, and the
   * GitHub project create runs behind write permission inside the
   * parent scope. WRITE_APPLICATIONS grants the create; the writable
   * tenant bound refuses foreign, missing, and archived applications
   * with one uniform 404; and the response mirrors the JWT create
   * exactly, seeded with the same original user request node, with
   * no audit row because the JWT create writes none either.
   */
  @Post('applications/:applicationId/work-graphs')
  @RequireScopes('WRITE_APPLICATIONS')
  createWorkGraph(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: CreateWorkGraphDto,
  ) {
    return this.graphs.createForKey(request.apiKey!, applicationId, dto);
  }

  /**
   * Key-authenticated work node create. Grounded in the GitHub
   * deployment status create: a token with push access adds child
   * records to a parent resource behind a write permission.
   * WRITE_APPLICATIONS grants the add; the writable tenant bound
   * refuses foreign, missing, and archived applications with one
   * uniform 404; the graph ownership check answers cross-application
   * and unknown graph ids with the same uniform 404; and the honest
   * 409s and 400s mirror the JWT addNode exactly.
   */
  @Post('applications/:applicationId/work-graphs/:graphId/nodes')
  @RequireScopes('WRITE_APPLICATIONS')
  addWorkGraphNode(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('graphId') graphId: string,
    @Body() dto: CreateWorkNodeDto,
  ) {
    return this.graphs.addNodeForKey(request.apiKey!, applicationId, graphId, dto);
  }

  /**
   * Key-authenticated work graph planning trigger. Grounded in the
   * market leaders: the GitHub workflow dispatch event triggers a
   * workflow run behind the Actions write permission, never read,
   * and the OpenAI thread run create starts an async run on a parent
   * resource straight from an API key with one active run per
   * thread - exactly the one active plan job per graph law here.
   * WRITE_APPLICATIONS grants the trigger; the writable tenant bound
   * refuses foreign, missing, and archived applications with one
   * uniform 404 and the graph ownership check answers
   * cross-application and unknown graph ids with the same uniform
   * 404; the plan input carries the honest key attribution and
   * requestedBy names the key creator because the worker executes
   * the plan as that user exactly like the JWT trigger; a key whose
   * creator no longer exists answers the named 409 instead of
   * enqueuing a job that could never run; and the plan core is the
   * one shared law, so a double-tap converges on the same job and a
   * keyed trigger racing the JWT trigger converges on the winning
   * job. There is no audit row because the JWT trigger writes none
   * either - the job row is the record.
   */
  @Post('applications/:applicationId/work-graphs/:graphId/plan')
  @RequireScopes('WRITE_APPLICATIONS')
  async planWorkGraph(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('graphId') graphId: string,
  ) {
    const key = request.apiKey!;
    const attributedUserId = actorAttribution(keyActorFromApiKey(key));
    if (attributedUserId === null) {
      throw new ConflictException('The key creator no longer exists.');
    }
    const graph = await this.graphs.getWritableGraphForKey(key, applicationId, graphId);
    const job = await this.jobs.enqueueGraphPlanForKey(key, attributedUserId, graph);
    return {
      jobId: job.id,
      applicationId,
      status: job.status,
      createdAt: job.createdAt,
    };
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
   * Key-authenticated conversation create. Grounded in the market
   * leaders: a GitHub token with write permission creates an issue
   * under a specific repository with only the title required, and
   * the OpenAI thread create builds an empty conversation object
   * straight from an API key. WRITE_APPLICATIONS grants the create;
   * the writable tenant bound refuses foreign, missing, and archived
   * applications with one uniform 404; and the response mirrors the
   * JWT create exactly.
   */
  @Post('applications/:applicationId/conversations')
  @RequireScopes('WRITE_APPLICATIONS')
  createConversation(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversations.createForKey(request.apiKey!, applicationId, dto);
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
   * Key-authenticated conversation archive. Grounded in the GitHub
   * conversation lock: write access is required to lock an issue, a
   * locked conversation blocks later comments, and repeat locks
   * succeed. WRITE_APPLICATIONS grants the archive; the writable
   * tenant bound refuses foreign, missing, and archived applications
   * with one uniform 404; the conversation ownership check answers
   * cross-application and unknown ids with the same uniform 404; and
   * the response mirrors the JWT archive exactly, with no audit row
   * because the JWT archive writes none.
   */
  @Post('applications/:applicationId/conversations/:conversationId/archive')
  @RequireScopes('WRITE_APPLICATIONS')
  archiveConversation(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.conversations.archiveForKey(
      request.apiKey!,
      applicationId,
      conversationId,
    );
  }

  /**
   * Key-authenticated conversation unarchive. Grounded in the
   * GitHub conversation unlock: write access is required to unlock
   * an issue, and repeat unlocks succeed. WRITE_APPLICATIONS grants
   * the unarchive; the writable tenant bound refuses foreign,
   * missing, and archived applications with one uniform 404; the
   * conversation ownership check answers cross-application and
   * unknown ids with the same uniform 404; and the response mirrors
   * the JWT unarchive exactly, with no audit row because the JWT
   * unarchive writes none.
   */
  @Post('applications/:applicationId/conversations/:conversationId/unarchive')
  @RequireScopes('WRITE_APPLICATIONS')
  unarchiveConversation(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.conversations.unarchiveForKey(
      request.apiKey!,
      applicationId,
      conversationId,
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

  /**
   * Key-authenticated reference create. Grounded in the market
   * leaders: a GitHub fine-grained token with Contents write creates
   * a file inside the parent repository, and the OpenAI file create
   * uploads a document straight from a Bearer API key with an
   * explicit purpose. WRITE_APPLICATIONS grants the create; the
   * writable tenant bound refuses foreign, missing, and archived
   * applications with one uniform 404; and the create lands in the
   * audit trail exactly once, attributed to the acting key, exactly
   * like the JWT create.
   */
  @Post('applications/:applicationId/references')
  @RequireScopes('WRITE_APPLICATIONS')
  createReference(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: CreateReferenceDto,
  ) {
    return this.references.createForKey(request.apiKey!, applicationId, dto);
  }

  /**
   * Key-authenticated reference extract. Grounded in the OpenAI vector
   * store file processing: attaching an uploaded file triggers AI
   * processing straight from an API key, and the file carries its
   * honest processing status with a recorded error. WRITE_APPLICATIONS
   * grants the processing run; the writable tenant bound refuses
   * foreign, missing, and archived applications with one uniform
   * 404; a failure marks the reference EXTRACTION_FAILED with the
   * recorded error; and a success lands in the audit trail exactly
   * once, attributed to the acting key.
   */
  @Post('applications/:applicationId/references/:referenceId/extract')
  @RequireScopes('WRITE_APPLICATIONS')
  extractReference(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('referenceId') referenceId: string,
  ) {
    return this.references.extractForKey(request.apiKey!, applicationId, referenceId);
  }

  /**
   * Key-authenticated reference delete. Grounded in the market leaders:
   * a GitHub fine-grained token needs Contents write to delete a file,
   * and the OpenAI file delete runs straight from a Bearer API key and
   * answers with the honest id plus deleted shape. WRITE_APPLICATIONS
   * grants the delete; the writable tenant bound refuses foreign,
   * missing, and archived applications with one uniform 404; and the
   * delete lands in the audit trail exactly once, attributed to the
   * acting key, exactly like the JWT delete.
   */
  @Post('applications/:applicationId/references/:referenceId/delete')
  @RequireScopes('WRITE_APPLICATIONS')
  deleteReference(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('referenceId') referenceId: string,
  ) {
    return this.references.removeForKey(request.apiKey!, applicationId, referenceId);
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

  /**
   * Key-authenticated deployment create. Grounded in the GitHub
   * create-a-deployment REST surface, where a fine-grained token
   * needs the Deployments repository permission set to write,
   * never read: the readiness gate answers BLOCKED with the same
   * honest 400 report as the JWT route, the recorded intent keeps
   * the none-configured adapter disclaimer, and the audit row is
   * stamped via genapi with the acting key.
   */
  @Post('applications/:applicationId/deployments')
  @RequireScopes('WRITE_APPLICATIONS')
  createDeployment(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: CreateDeploymentDto,
  ) {
    return this.deployments.createDeploymentForKey(request.apiKey!, applicationId, dto);
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

  /**
   * Key-authenticated file revision history. Grounded in the GitHub
   * commit listing: file history stays readable with nothing more than
   * read access, newest first, so the rows mirror the JWT revision
   * listing exactly, tombstone revision included after a delete. Reads
   * stay possible on archived applications and never write an audit
   * row.
   */
  @Get('applications/:applicationId/files/:fileId/revisions')
  @RequireScopes('READ_APPLICATIONS')
  listFileRevisions(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('fileId') fileId: string,
  ) {
    return this.files.revisionsForKey(request.apiKey!, applicationId, fileId);
  }

  /**
   * Key-authenticated file restore. Grounded in the market leaders:
   * Vercel instant rollback repoints production without rewriting
   * history, and the GitHub contents update needs write access plus
   * an expected state token. WRITE_APPLICATIONS grants the restore,
   * the revision to restore rides the path, the expected current
   * revision rides the body exactly like the JWT route, and the
   * response mirrors the JWT restore exactly.
   */
  @Post('applications/:applicationId/files/:fileId/restore/:revision')
  @RequireScopes('WRITE_APPLICATIONS')
  restoreFile(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('fileId') fileId: string,
    @Param('revision', ParseIntPipe) revision: number,
    @Body() body: RestoreFileDto,
  ) {
    return this.files.restoreForKey(
      request.apiKey!,
      applicationId,
      fileId,
      revision,
      body.expectedCurrentRevision,
    );
  }

  /**
   * Key-authenticated file delete. Grounded in the GitHub contents
   * delete: write permission is required and the expected state token
   * rides the request, with concurrent deletes warned to run
   * serially. WRITE_APPLICATIONS grants the delete, the expected
   * revision rides the path exactly like the JWT route, and the
   * response mirrors the JWT delete exactly: exactly one tombstone
   * revision lands, never two, and the loser answers clean.
   */
  @Post('applications/:applicationId/files/:fileId/delete/revision/:expectedRevision')
  @RequireScopes('WRITE_APPLICATIONS')
  deleteFile(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Param('fileId') fileId: string,
    @Param('expectedRevision', ParseIntPipe) expectedRevision: number,
  ) {
    return this.files.deleteForKey(request.apiKey!, applicationId, fileId, expectedRevision);
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

  /**
   * Key-authenticated AI source generation trigger. Grounded in the
   * market leaders: the OpenAI create-a-model-response and the
   * Anthropic create-a-message both run generation straight from an
   * API key, and an OpenAI key is bounded to its organization and
   * project the way this key is bounded to its organization, with
   * revocation stopping generation instantly. WRITE_APPLICATIONS
   * grants the trigger; the writable tenant bound refuses foreign,
   * missing, and archived applications with one uniform 404; the job
   * input carries the honest key attribution (via genapi with the
   * acting key id and name) and requestedBy names the key creator
   * because the job executes as that user exactly like the JWT
   * trigger; a key whose creator no longer exists answers the named
   * 409 instead of enqueuing a job that could never run; and the
   * Stripe idempotency law is the one shared core, so a double-tap
   * converges on the same job. There is no audit row because the JWT
   * trigger writes none either - the job row is the record.
   */
  @Post('applications/:applicationId/generate')
  @RequireScopes('WRITE_APPLICATIONS')
  async generateSource(
    @Req() request: KeyedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: GenerateSourceDto,
  ) {
    const key = request.apiKey!;
    const attributedUserId = actorAttribution(keyActorFromApiKey(key));
    if (attributedUserId === null) {
      throw new ConflictException('The key creator no longer exists.');
    }
    const job = await this.jobs.enqueueForKey(
      key,
      applicationId,
      JobType.CODE_GENERATION,
      {
        task: 'GENERATE_SOURCE_FILES',
        prompt: dto.prompt.trim(),
        requestedBy: attributedUserId,
        via: 'genapi',
        apiKeyId: key.id,
        apiKeyName: key.name,
      },
      dto.idempotencyKey,
    );
    return {
      jobId: job.id,
      applicationId,
      status: job.status,
      createdAt: job.createdAt,
    };
  }
}
