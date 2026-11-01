import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

const hasDatabase = typeof process.env.DATABASE_URL === 'string'
  && process.env.DATABASE_URL.startsWith('postgres');
const hasJwtSecret = typeof process.env.JWT_ACCESS_SECRET === 'string'
  && process.env.JWT_ACCESS_SECRET.length >= 32;
const suite = hasDatabase && hasJwtSecret ? describe : describe.skip;

interface TokenPair { accessToken: string; refreshToken: string; }
interface UserContext { email: string; tokens: TokenPair; userId: string; }
interface KeyContext { id: string; key: string; }
interface GraphContext { id: string; version: number; }
interface ApiResponse { status: number; body: Record<string, unknown>; }

/**
 * Keyed work graph planning trigger over the real app and the real CI
 * PostgreSQL. Grounded in the market leaders: the GitHub workflow
 * dispatch event triggers a workflow run behind the Actions write
 * permission, never read, and the OpenAI thread run create starts an
 * async run on a parent resource straight from an API key with one
 * active run per thread - exactly the one active plan job per graph
 * law. The plan core is the one shared law for both surfaces, so a
 * replay answers the active job, a double-tap converges on the same
 * job, a keyed trigger racing the JWT trigger converges on the
 * winning job, a cancelled plan requeues the same job, and every
 * refusal leaves no job row behind.
 */
suite('genapi key-authenticated work graph plan flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId = '';
  let foreignOrganizationId = '';
  let projectIdA = '';
  let applicationIdA = '';
  let foreignApplicationId = '';
  let archivedApplicationId = '';
  let graphA: GraphContext;
  let graphC: GraphContext;
  let graphD: GraphContext;
  let graphE: GraphContext;
  let graphF: GraphContext;
  let foreignGraph: GraphContext;
  let writerKey: KeyContext;
  let readerKey: KeyContext;
  let orgWriterKey: KeyContext;
  let shortLivedKey: KeyContext;
  let revokedKey: KeyContext;
  let irisWriterKey: KeyContext;
  let samOrgId = '';
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);
  const password = 'genapi-plan-password-123';

  const api = async (
    method: string,
    path: string,
    body: unknown = undefined,
    accessToken?: string,
  ): Promise<ApiResponse> => {
    const response = await fetch(baseUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: 'Bearer ' + accessToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    return { status: response.status, body: parsed };
  };

  const registerUser = async (name: string): Promise<UserContext> => {
    const email = 'genesis-plan-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password,
      displayName: name,
    });
    expect(response.status).toBe(201);
    const user = response.body.user as { id: string };
    createdUserIds.push(user.id);
    return {
      email,
      tokens: {
        accessToken: response.body.accessToken as string,
        refreshToken: response.body.refreshToken as string,
      },
      userId: user.id,
    };
  };

  const createKey = async (
    accessToken: string,
    orgId: string,
    name: string,
    scopes: string[],
    expiresAt?: string,
  ): Promise<KeyContext> => {
    const body = expiresAt === undefined
      ? { name, scopes }
      : { name, scopes, expiresAt };
    const response = await api(
      'POST',
      '/organizations/' + orgId + '/api-keys',
      body,
      accessToken,
    );
    expect(response.status).toBe(201);
    const created = response.body as { id: string; key: string };
    expect(created.key).toMatch(/^gn_live_[A-Za-z0-9_-]{43}$/);
    return { id: created.id, key: created.key };
  };

  const createGraph = async (
    accessToken: string,
    applicationId: string,
    title: string,
  ): Promise<GraphContext> => {
    const response = await api(
      'POST',
      '/applications/' + applicationId + '/work-graphs',
      { title, sourcePrompt: 'Plan the delivery for ' + title + '.' },
      accessToken,
    );
    expect(response.status).toBe(201);
    const created = response.body as { id: string; version: number };
    return { id: created.id, version: created.version };
  };

  const planKeyed = (applicationId: string, graphId: string, key: string | undefined) =>
    api('POST', '/genapi/applications/' + applicationId + '/work-graphs/' + graphId + '/plan', undefined, key);

  const planJwt = (graphId: string, accessToken: string) =>
    api('POST', '/work-graphs/' + graphId + '/plan', undefined, accessToken);

  const planKeyForGraph = (graph: GraphContext) =>
    'workgraph-plan:' + graph.id + ':v' + graph.version;

  const jobsForGraph = (applicationId: string, graph: GraphContext) =>
    prisma.workJob.count({ where: { applicationId, idempotencyKey: planKeyForGraph(graph) } });

  const seedTenant = async (owner: UserContext, projectName: string, appName: string) => {
    const orgs = await api('GET', '/organizations', undefined, owner.tokens.accessToken);
    expect(orgs.status).toBe(200);
    const orgId = (orgs.body as unknown as Array<{ id: string }>)[0].id;
    const workspaces = await api('GET', '/workspaces', undefined, owner.tokens.accessToken);
    expect(workspaces.status).toBe(200);
    const workspaceId = (workspaces.body as unknown as Array<{ id: string }>)[0].id;
    const project = await api(
      'POST',
      '/workspaces/' + workspaceId + '/projects',
      { name: projectName },
      owner.tokens.accessToken,
    );
    expect(project.status).toBe(201);
    const projectId = (project.body as { id: string }).id;
    const application = await api(
      'POST',
      '/projects/' + projectId + '/applications',
      { name: appName },
      owner.tokens.accessToken,
    );
    expect(application.status).toBe(201);
    return {
      organizationId: orgId,
      projectId,
      applicationId: (application.body as { id: string }).id,
    };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({}).compile();
    await moduleRef.close();

    const { AppModule } = await import('../app.module');
    const testing = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = testing.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }));
    await app.init();
    await app.listen(0, '127.0.0.1');

    const server = app.getHttpServer() as import('node:http').Server;
    const address = server.address() as { port: number };
    baseUrl = 'http://127.0.0.1:' + address.port + '/api/v1';
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const orgIds = [organizationId, foreignOrganizationId, samOrgId].filter((id) => id !== '');
    if (orgIds.length > 0) {
      await prisma.auditEvent.deleteMany({ where: { organizationId: { in: orgIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
    }
    if (samOrgId !== '') {
      await prisma.organization.deleteMany({ where: { id: samOrgId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it('seeds two tenants, work graphs, and keys with distinct scopes', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const tenantA = await seedTenant(hank, 'Genapi Plan Project', 'Genapi Plan App');
    organizationId = tenantA.organizationId;
    projectIdA = tenantA.projectId;
    applicationIdA = tenantA.applicationId;
    const tenantB = await seedTenant(iris, 'Iris Plan Project', 'Iris Plan App');
    foreignOrganizationId = tenantB.organizationId;
    foreignApplicationId = tenantB.applicationId;

    graphA = await createGraph(hank.tokens.accessToken, applicationIdA, 'Parity Graph');
    graphC = await createGraph(hank.tokens.accessToken, applicationIdA, 'Requeue Graph');
    graphD = await createGraph(hank.tokens.accessToken, applicationIdA, 'Tap Race Graph');
    graphE = await createGraph(hank.tokens.accessToken, applicationIdA, 'Cross Race Graph');
    graphF = await createGraph(hank.tokens.accessToken, applicationIdA, 'Draft Law Graph');
    foreignGraph = await createGraph(iris.tokens.accessToken, foreignApplicationId, 'Iris Graph');

    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'Plan Writer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    readerKey = await createKey(hank.tokens.accessToken, organizationId, 'Plan Reader', ['READ_APPLICATIONS']);
    orgWriterKey = await createKey(hank.tokens.accessToken, organizationId, 'Plan Org Writer', ['READ_ORGANIZATION', 'WRITE_ORGANIZATION']);
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Plan Short Lived',
      ['READ_APPLICATIONS', 'WRITE_APPLICATIONS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(hank.tokens.accessToken, organizationId, 'Plan Revoked', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    irisWriterKey = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Iris Plan Writer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
  });

  it('converges the JWT replay on the keyed job with key-creator attribution', async () => {
    const keyed = await planKeyed(applicationIdA, graphA.id, writerKey.key);
    expect(keyed.status).toBe(201);
    const keyedBody = keyed.body as { jobId: string; applicationId: string; status: string; createdAt: string };
    expect(Object.keys(keyed.body).sort()).toEqual(['applicationId', 'createdAt', 'jobId', 'status']);
    expect(keyedBody.applicationId).toBe(applicationIdA);
    expect(keyedBody.status).toBe('QUEUED');
    expect(typeof keyedBody.jobId).toBe('string');
    expect(typeof keyedBody.createdAt).toBe('string');

    const jwt = await planJwt(graphA.id, hank.tokens.accessToken);
    expect(jwt.status).toBe(201);
    const jwtBody = jwt.body as { jobId: string };
    expect(jwtBody.jobId).toBe(keyedBody.jobId);
    expect(Object.keys(jwt.body).sort()).toEqual(Object.keys(keyed.body).sort());

    expect(await jobsForGraph(applicationIdA, graphA)).toBe(1);

    const job = await prisma.workJob.findUnique({
      where: { id: keyedBody.jobId },
      select: { type: true, status: true, idempotencyKey: true, input: true },
    });
    expect(job).not.toBeNull();
    expect(job?.type).toBe('REQUIREMENTS_ANALYSIS');
    expect(job?.status).toBe('QUEUED');
    expect(job?.idempotencyKey).toBe(planKeyForGraph(graphA));
    const input = (job?.input ?? {}) as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(['apiKeyId', 'apiKeyName', 'graphId', 'requestedBy', 'task', 'via']);
    expect(input.task).toBe('PLAN_WORK_GRAPH');
    expect(input.graphId).toBe(graphA.id);
    expect(input.requestedBy).toBe(hank.userId);
    expect(input.via).toBe('genapi');
    expect(input.apiKeyId).toBe(writerKey.id);
    expect(input.apiKeyName).toBe('Plan Writer');

    const keyedList = await api('GET', '/genapi/applications/' + applicationIdA + '/jobs', undefined, readerKey.key);
    expect(keyedList.status).toBe(200);
    const keyedIds = (keyedList.body as unknown as Array<{ id: string }>).map((item) => item.id);
    expect(keyedIds).toContain(keyedBody.jobId);
  });

  it('refuses triggers without side effects', async () => {
    const rowsBefore = await jobsForGraph(applicationIdA, graphA);

    const messages = new Set<string>();
    for (const wrongKey of [readerKey, orgWriterKey]) {
      const refused = await planKeyed(applicationIdA, graphA.id, wrongKey.key);
      expect(refused.status).toBe(403);
      messages.add((refused.body as { message: string }).message);
    }
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('The API key does not grant the required scope.');

    expect(await jobsForGraph(applicationIdA, graphA)).toBe(rowsBefore);
  });

  it('tenant-bounds the trigger behind uniform 404s per guard', async () => {
    const rowsGraphA = await jobsForGraph(applicationIdA, graphA);

    const applicationMessages = new Set<string>();
    for (const [applicationId, graphId, keyContext] of [
      [applicationIdA, graphA.id, irisWriterKey],
      [foreignApplicationId, foreignGraph.id, writerKey],
      ['unknown-application-id', graphA.id, writerKey],
    ] as Array<[string, string, KeyContext]>) {
      const refused = await planKeyed(applicationId, graphId, keyContext.key);
      expect(refused.status).toBe(404);
      applicationMessages.add((refused.body as { message: string }).message);
    }
    expect(applicationMessages.size).toBe(1);
    expect(Array.from(applicationMessages)[0]).toBe('Application not found.');

    const graphMessages = new Set<string>();
    for (const graphId of [foreignGraph.id, 'unknown-graph-id']) {
      const refused = await planKeyed(applicationIdA, graphId, writerKey.key);
      expect(refused.status).toBe(404);
      graphMessages.add((refused.body as { message: string }).message);
    }
    expect(graphMessages.size).toBe(1);
    expect(Array.from(graphMessages)[0]).toBe('Work graph not found.');

    expect(await jobsForGraph(applicationIdA, graphA)).toBe(rowsGraphA);
    expect(await jobsForGraph(foreignApplicationId, foreignGraph)).toBe(0);
  });

  it('answers one honest 409 for non-draft graphs on both surfaces', async () => {
    const rowsBefore = await jobsForGraph(applicationIdA, graphF);
    await prisma.workGraph.update({
      where: { id: graphF.id },
      data: { status: 'READY' },
    });

    const keyed = await planKeyed(applicationIdA, graphF.id, writerKey.key);
    expect(keyed.status).toBe(409);
    expect((keyed.body as { message: string }).message).toBe('Only draft work graphs can be queued for planning.');

    const jwt = await planJwt(graphF.id, hank.tokens.accessToken);
    expect(jwt.status).toBe(409);
    expect((jwt.body as { message: string }).message).toBe('Only draft work graphs can be queued for planning.');

    expect(await jobsForGraph(applicationIdA, graphF)).toBe(rowsBefore);
  });

  it('writes zero audit rows for plan triggers and refusals', async () => {
    const countBefore = await prisma.auditEvent.count({
      where: { organizationId },
    });

    const trigger = await planKeyed(applicationIdA, graphD.id, writerKey.key);
    expect(trigger.status).toBe(201);
    const replay = await planKeyed(applicationIdA, graphD.id, writerKey.key);
    expect(replay.status).toBe(201);
    expect((replay.body as { jobId: string }).jobId).toBe((trigger.body as { jobId: string }).jobId);

    const refused = await planKeyed(applicationIdA, graphD.id, readerKey.key);
    expect(refused.status).toBe(403);
    const foreign = await planKeyed(applicationIdA, foreignGraph.id, writerKey.key);
    expect(foreign.status).toBe(404);

    const countAfter = await prisma.auditEvent.count({
      where: { organizationId },
    });
    expect(countAfter).toBe(countBefore);
  });

  it('requeues the same plan job after a keyed cancellation', async () => {
    const first = await planKeyed(applicationIdA, graphC.id, writerKey.key);
    expect(first.status).toBe(201);
    const jobId = (first.body as { jobId: string }).jobId;
    expect(await jobsForGraph(applicationIdA, graphC)).toBe(1);

    const replay = await planJwt(graphC.id, hank.tokens.accessToken);
    expect(replay.status).toBe(201);
    expect((replay.body as { jobId: string }).jobId).toBe(jobId);
    expect(await jobsForGraph(applicationIdA, graphC)).toBe(1);

    const cancel = await api(
      'POST',
      '/genapi/applications/' + applicationIdA + '/jobs/' + jobId + '/cancel',
      undefined,
      writerKey.key,
    );
    expect(cancel.status).toBe(201);
    expect((cancel.body as { status: string }).status).toBe('CANCELLED');

    const replan = await planKeyed(applicationIdA, graphC.id, writerKey.key);
    expect(replan.status).toBe(201);
    expect((replan.body as { jobId: string }).jobId).toBe(jobId);
    expect((replan.body as { status: string }).status).toBe('QUEUED');

    expect(await jobsForGraph(applicationIdA, graphC)).toBe(1);
    const row = await prisma.workJob.findFirst({
      where: { applicationId: applicationIdA, idempotencyKey: planKeyForGraph(graphC) },
      select: { status: true },
    });
    expect(row?.status).toBe('QUEUED');
  });

  it('answers honestly when the key creator no longer exists', async () => {
    const sam = await registerUser('sam');
    const samOrgs = await api('GET', '/organizations', undefined, sam.tokens.accessToken);
    expect(samOrgs.status).toBe(200);
    samOrgId = (samOrgs.body as unknown as Array<{ id: string }>)[0].id;
    await prisma.membership.create({
      data: { userId: sam.userId, organizationId, role: 'ADMIN' },
    });
    const samKey = await createKey(sam.tokens.accessToken, organizationId, 'Orphan Plan Writer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);

    await prisma.user.delete({ where: { id: sam.userId } });

    const rowsBefore = await jobsForGraph(applicationIdA, graphE);
    const refused = await planKeyed(applicationIdA, graphE.id, samKey.key);
    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toBe('The key creator no longer exists.');
    expect(await jobsForGraph(applicationIdA, graphE)).toBe(rowsBefore);
  });

  it('race: a keyed double-tap converges on one queued plan job', async () => {
    const rowsBefore = await jobsForGraph(applicationIdA, graphE);
    const raced = await Promise.all([
      planKeyed(applicationIdA, graphE.id, writerKey.key),
      planKeyed(applicationIdA, graphE.id, writerKey.key),
    ]);
    for (const response of raced) {
      expect(response.status).toBe(201);
      expect((response.body as { status: string }).status).toBe('QUEUED');
    }
    const jobIds = new Set(raced.map((response) => (response.body as { jobId: string }).jobId));
    expect(jobIds.size).toBe(1);
    expect(await jobsForGraph(applicationIdA, graphE)).toBe(rowsBefore + 1);
  });

  it('race: keyed against JWT converges both callers on the winning job', async () => {
    const rowsBefore = await jobsForGraph(applicationIdA, graphD);
    const raced = await Promise.all([
      planKeyed(applicationIdA, graphD.id, writerKey.key),
      planJwt(graphD.id, hank.tokens.accessToken),
    ]);
    // Both surfaces run the one shared plan core, so whichever insert
    // wins, the loser rechecks the active job and converges on it:
    // both callers answer 201 with the same job id, never a raw 409.
    for (const response of raced) {
      expect(response.status).toBe(201);
    }
    const jobIds = new Set(raced.map((response) => (response.body as { jobId: string }).jobId));
    expect(jobIds.size).toBe(1);
    expect(await jobsForGraph(applicationIdA, graphD)).toBe(rowsBefore + 1);

    const winnerId = Array.from(jobIds)[0];
    const row = await prisma.workJob.findUnique({
      where: { id: winnerId },
      select: { input: true },
    });
    const input = (row?.input ?? {}) as Record<string, unknown>;
    if (input.via === 'genapi') {
      expect(input.apiKeyId).toBe(writerKey.id);
      expect(input.requestedBy).toBe(hank.userId);
    } else {
      expect(input.requestedBy).toBe(hank.userId);
      expect(input.via).toBeUndefined();
    }
  });

  it('keeps an archived application behind the writable 404', async () => {
    const created = await api(
      'POST',
      '/projects/' + projectIdA + '/applications',
      { name: 'Genapi Archived Plan App' },
      hank.tokens.accessToken,
    );
    expect(created.status).toBe(201);
    archivedApplicationId = (created.body as { id: string }).id;
    const archivedGraph = await createGraph(hank.tokens.accessToken, archivedApplicationId, 'Archived Graph');
    const archived = await api(
      'POST',
      '/projects/' + projectIdA + '/applications/' + archivedApplicationId + '/archive',
      {},
      hank.tokens.accessToken,
    );
    expect(archived.status).toBe(201);

    const refused = await planKeyed(archivedApplicationId, archivedGraph.id, writerKey.key);
    expect(refused.status).toBe(404);
    expect((refused.body as { message: string }).message).toBe('Application not found.');
    expect(await jobsForGraph(archivedApplicationId, archivedGraph)).toBe(0);
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect([200, 201]).toContain(revoke.status);

    const revokedTry = await planKeyed(applicationIdA, graphA.id, revokedKey.key);
    expect(revokedTry.status).toBe(401);
    expect((revokedTry.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredTry = await planKeyed(applicationIdA, graphA.id, shortLivedKey.key);
    expect(expiredTry.status).toBe(401);
    expect((expiredTry.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const anonymous = await planKeyed(applicationIdA, graphA.id, undefined);
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { message: string }).message).toBe('A valid GENESIS API key is required.');
  });
});
