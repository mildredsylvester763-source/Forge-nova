import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

const hasDatabase = typeof process.env.DATABASE_URL === 'string'
  && process.env.DATABASE_URL.startsWith('postgres');
const hasJwtSecret = typeof process.env.JWT_ACCESS_SECRET === 'string'
  && process.env.JWT_ACCESS_SECRET.length >= 32;
const suite = hasDatabase && hasJwtSecret ? describe : describe.skip;

interface TokenPair { accessToken: string; refreshToken: string; }

interface UserContext { email: string; tokens: TokenPair; userId: string; }

interface ApiResponse { status: number; body: Record<string, unknown>; }

interface AuditRow {
  actorUserId: string | null;
  organizationId: string | null;
  outcome: string;
  metadata: { via?: string; apiKeyId?: string; status?: string };
}

suite('genapi key-authenticated async work flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let hank: UserContext;
  let iris: UserContext;
  let projectIdA: string;
  let applicationIdA: string;
  let applicationIdB: string;
  let organizationIdA: string;
  let graphIdA: string;
  let graphIdB: string;
  let foreignGraphId: string;
  let firstNodeId: string;
  let jobAId: string;
  let jobBId: string;
  let foreignJobId: string;
  let readerKey: string;
  let writerKey: string;
  let writerKeyId: string;
  let writerOnlyKey: string;
  let irisWriterKey: string;
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);

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

  const genapiGet = (path: string, key: string | undefined) =>
    api('GET', '/genapi/' + path, undefined, key);

  const genapiCancel = (applicationId: string, jobId: string, key: string | undefined) =>
    api('POST', '/genapi/applications/' + applicationId + '/jobs/' + jobId + '/cancel', {}, key);

  const registerUser = async (name: string): Promise<UserContext> => {
    const email = 'genesis-jobs-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'genapi-jobs-test-password-123',
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
    token: string,
    organizationId: string,
    name: string,
    scopes: string[],
    expiresAt?: string,
  ) => {
    const body = expiresAt === undefined ? { name, scopes } : { name, scopes, expiresAt };
    return api('POST', '/organizations/' + organizationId + '/api-keys', body, token);
  };

  const seedTenant = async (owner: UserContext, projectName: string, appName: string) => {
    const orgs = await api('GET', '/organizations', undefined, owner.tokens.accessToken);
    expect(orgs.status).toBe(200);
    const organizationId = (orgs.body as unknown as Array<{ id: string }>)[0].id;
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
      organizationId,
      projectId,
      applicationId: (application.body as { id: string }).id,
    };
  };

  const auditRows = async (jobId: string): Promise<AuditRow[]> => {
    const { PrismaService } = await import('../database/prisma.service');
    const prisma = app.get(PrismaService);
    const rows = await prisma.auditEvent.findMany({
      where: { action: 'job.cancel', resourceId: jobId },
    });
    return rows as unknown as AuditRow[];
  };

  const createGraph = async (owner: UserContext, applicationId: string, title: string) => {
    const graph = await api(
      'POST',
      '/applications/' + applicationId + '/work-graphs',
      { title, sourcePrompt: 'A landing page with a contact form and honest validation.' },
      owner.tokens.accessToken,
    );
    expect(graph.status).toBe(201);
    return graph.body as { id: string; nodes: Array<{ id: string }> };
  };

  const planGraph = async (owner: UserContext, graphId: string) => {
    const plan = await api('POST', '/work-graphs/' + graphId + '/plan', {}, owner.tokens.accessToken);
    expect(plan.status).toBe(201);
    return (plan.body as { jobId: string }).jobId;
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
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');

    const server = app.getHttpServer() as import('node:http').Server;
    const address = server.address() as { port: number };
    baseUrl = 'http://127.0.0.1:' + address.port + '/api/v1';
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      const { PrismaService } = await import('../database/prisma.service');
      const prisma = app.get(PrismaService);
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('seeds two tenants, graphs, queued plan jobs, and keys with distinct scopes', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const tenantA = await seedTenant(hank, 'Genapi Jobs Project', 'Genapi Jobs App');
    projectIdA = tenantA.projectId;
    applicationIdA = tenantA.applicationId;
    organizationIdA = tenantA.organizationId;
    const tenantB = await seedTenant(iris, 'Iris Jobs Project', 'Iris Jobs App');
    applicationIdB = tenantB.applicationId;

    const graphA = await createGraph(hank, applicationIdA, 'Seed Graph');
    graphIdA = graphA.id;
    firstNodeId = graphA.nodes[0].id;
    const node = await api(
      'POST',
      '/work-graphs/' + graphIdA + '/nodes',
      { key: 'site-build', type: 'BUILD', title: 'Build the site', dependsOnNodeIds: [firstNodeId] },
      hank.tokens.accessToken,
    );
    expect(node.status).toBe(201);

    jobAId = await planGraph(hank, graphIdA);

    const graphB = await createGraph(hank, applicationIdA, 'Race Graph');
    graphIdB = graphB.id;
    jobBId = await planGraph(hank, graphIdB);

    const foreignGraph = await createGraph(iris, applicationIdB, 'Iris Graph');
    foreignGraphId = foreignGraph.id;
    foreignJobId = await planGraph(iris, foreignGraphId);

    const reader = await createKey(hank.tokens.accessToken, organizationIdA, 'reader', ['READ_APPLICATIONS']);
    expect(reader.status).toBe(201);
    readerKey = (reader.body as { key: string }).key;

    const writer = await createKey(hank.tokens.accessToken, organizationIdA, 'writer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    expect(writer.status).toBe(201);
    writerKey = (writer.body as { key: string }).key;
    writerKeyId = (writer.body as { id: string }).id;

    const writerOnly = await createKey(hank.tokens.accessToken, organizationIdA, 'writer-only', ['WRITE_APPLICATIONS']);
    expect(writerOnly.status).toBe(201);
    writerOnlyKey = (writerOnly.body as { key: string }).key;

    const irisWriter = await createKey(iris.tokens.accessToken, tenantB.organizationId, 'iris-writer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    expect(irisWriter.status).toBe(201);
    irisWriterKey = (irisWriter.body as { key: string }).key;
  });

  it('lists work graphs for a key with parity against the JWT surface', async () => {
    const listed = await genapiGet('applications/' + applicationIdA + '/work-graphs', readerKey);
    expect(listed.status).toBe(200);
    const items = listed.body as unknown as Array<{ id: string; title: string; status: string }>
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.title).sort()).toEqual(['Race Graph', 'Seed Graph']);

    const jwtListed = await api('GET', '/applications/' + applicationIdA + '/work-graphs', undefined, hank.tokens.accessToken);
    expect(jwtListed.status).toBe(200);
    expect(listed.body).toEqual(jwtListed.body);
  });

  it('inspects a work graph for a key with parity and honest dependency shape', async () => {
    const inspected = await genapiGet('applications/' + applicationIdA + '/work-graphs/' + graphIdA, readerKey);
    expect(inspected.status).toBe(200);
    const graph = inspected.body as {
      id: string;
      title: string;
      status: string;
      nodes: Array<{ key: string; incomingDependencies: Array<{ fromNodeId: string }> }>;
    };
    expect(graph.id).toBe(graphIdA);
    expect(graph.nodes).toHaveLength(2);
    const buildNode = graph.nodes.find((entry) => entry.key === 'site-build');
    expect(buildNode).toBeDefined();
    expect(buildNode ? buildNode.incomingDependencies.map((edge) => edge.fromNodeId) : []).toEqual([firstNodeId]);

    const jwtInspected = await api('GET', '/work-graphs/' + graphIdA, undefined, hank.tokens.accessToken);
    expect(jwtInspected.status).toBe(200);
    expect(inspected.body).toEqual(jwtInspected.body);
  });

  it('keeps foreign and unknown graphs behind the same uniform 404', async () => {
    const probes = [
      ['applications/' + applicationIdA + '/work-graphs/unknown-graph-id', readerKey],
      ['applications/' + applicationIdA + '/work-graphs/' + foreignGraphId, readerKey],
      ['applications/' + applicationIdB + '/work-graphs/' + graphIdA, irisWriterKey],
    ] as Array<[string, string]>;
    const messages = new Set<string>();
    for (const [path, key] of probes) {
      const refused = await genapiGet(path, key);
      expect(refused.status).toBe(404);
      messages.add(String((refused.body as { message?: string }).message));
    }
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Work graph not found.');

    // A foreign key fails one step earlier at the application bound and
    // must still answer 404, never leaking that the application exists.
    const foreignKey = await genapiGet('applications/' + applicationIdA + '/work-graphs/' + graphIdA, irisWriterKey);
    expect(foreignKey.status).toBe(404);

    // A same-organization key probing a foreign application is refused
    // at the application bound with the same honest 404 status.
    const foreignApp = await genapiGet('applications/' + applicationIdB + '/work-graphs/' + graphIdA, readerKey);
    expect(foreignApp.status).toBe(404);
  });

  it('validates a work graph for a key with parity against the JWT surface', async () => {
    const validated = await genapiGet('applications/' + applicationIdA + '/work-graphs/' + graphIdA + '/validate', readerKey);
    expect(validated.status).toBe(200);
    const report = validated.body as { valid: boolean; graphId: string; nodeCount: number; edgeCount: number; cycles: unknown };
    expect(report.valid).toBe(true);
    expect(report.graphId).toBe(graphIdA);
    expect(report.nodeCount).toBe(2);
    expect(report.edgeCount).toBe(1);
    expect(Array.isArray(report.cycles)).toBe(true);

    const jwtValidated = await api('GET', '/work-graphs/' + graphIdA + '/validate', undefined, hank.tokens.accessToken);
    expect(jwtValidated.status).toBe(200);
    expect(validated.body).toEqual(jwtValidated.body);

    const foreign = await genapiGet('applications/' + applicationIdA + '/work-graphs/' + foreignGraphId + '/validate', readerKey);
    expect(foreign.status).toBe(404);
  });

  it('inspects a queued job for a key with parity against the JWT surface', async () => {
    const inspected = await genapiGet('applications/' + applicationIdA + '/jobs/' + jobAId, readerKey);
    expect(inspected.status).toBe(200);
    const job = inspected.body as { id: string; type: string; status: string };
    expect(job.id).toBe(jobAId);
    expect(job.type).toBe('REQUIREMENTS_ANALYSIS');
    expect(job.status).toBe('QUEUED');

    const jwtInspected = await api('GET', '/applications/' + applicationIdA + '/jobs/' + jobAId, undefined, hank.tokens.accessToken);
    expect(jwtInspected.status).toBe(200);
    expect(inspected.body).toEqual(jwtInspected.body);
  });

  it('keeps foreign and unknown jobs behind the same uniform 404', async () => {
    const probes = [
      ['applications/' + applicationIdA + '/jobs/unknown-job-id', readerKey],
      ['applications/' + applicationIdA + '/jobs/' + foreignJobId, readerKey],
      ['applications/' + applicationIdB + '/jobs/' + jobAId, irisWriterKey],
    ] as Array<[string, string]>;
    const messages = new Set<string>();
    for (const [path, key] of probes) {
      const refused = await genapiGet(path, key);
      expect(refused.status).toBe(404);
      messages.add(String((refused.body as { message?: string }).message));
    }
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Job not found.');

    const foreignKey = await genapiGet('applications/' + applicationIdA + '/jobs/' + jobAId, irisWriterKey);
    expect(foreignKey.status).toBe(404);
  });

  it('refuses a write-only key on every async-work read endpoint', async () => {
    const paths = [
      'applications/' + applicationIdA + '/work-graphs',
      'applications/' + applicationIdA + '/work-graphs/' + graphIdA,
      'applications/' + applicationIdA + '/work-graphs/' + graphIdA + '/validate',
      'applications/' + applicationIdA + '/jobs',
      'applications/' + applicationIdA + '/jobs/' + jobAId,
    ];
    for (const path of paths) {
      const refused = await genapiGet(path, writerOnlyKey);
      expect(refused.status).toBe(403);
    }
  });

  it('refuses a read-scoped key on cancel with zero side effects', async () => {
    const refused = await genapiCancel(applicationIdA, jobAId, readerKey);
    expect(refused.status).toBe(403);

    const stillQueued = await genapiGet('applications/' + applicationIdA + '/jobs/' + jobAId, readerKey);
    expect(stillQueued.status).toBe(200);
    expect((stillQueued.body as { status: string }).status).toBe('QUEUED');
    expect(await auditRows(jobAId)).toHaveLength(0);
  });

  it('cancels a queued job via key exactly once with honest audit attribution', async () => {
    const cancelled = await genapiCancel(applicationIdA, jobAId, writerKey);
    expect(cancelled.status).toBe(201);
    const body = cancelled.body as { id: string; status: string };
    expect(body.id).toBe(jobAId);
    expect(body.status).toBe('CANCELLED');

    const inspected = await genapiGet('applications/' + applicationIdA + '/jobs/' + jobAId, readerKey);
    expect(inspected.status).toBe(200);
    expect((inspected.body as { status: string }).status).toBe('CANCELLED');

    const rows = await auditRows(jobAId);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(hank.userId);
    expect(rows[0].organizationId).toBe(organizationIdA);
    expect(rows[0].outcome).toBe('SUCCESS');
    expect(rows[0].metadata.via).toBe('genapi');
    expect(rows[0].metadata.apiKeyId).toBe(writerKeyId);
    expect(rows[0].metadata.status).toBe('CANCELLED');
  });

  it('replays cancel as an honest no-op without a second audit row', async () => {
    const replay = await genapiCancel(applicationIdA, jobAId, writerKey);
    expect(replay.status).toBe(201);
    const body = replay.body as { id: string; status: string; cancellationRequested: boolean };
    expect(body.id).toBe(jobAId);
    expect(body.status).toBe('CANCELLED');
    expect(body.cancellationRequested).toBe(false);
    expect(await auditRows(jobAId)).toHaveLength(1);
  });

  it('races two keys on cancel into exactly one transition and one audit row', async () => {
    const second = await createKey(hank.tokens.accessToken, organizationIdA, 'writer-two', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    expect(second.status).toBe(201);
    const writerTwoKey = (second.body as { key: string }).key;
    const writerTwoKeyId = (second.body as { id: string }).id;

    const raced = await Promise.all([
      genapiCancel(applicationIdA, jobBId, writerKey),
      genapiCancel(applicationIdA, jobBId, writerTwoKey),
    ]);
    for (const response of raced) {
      expect(response.status).toBe(201);
      expect((response.body as { status: string }).status).toBe('CANCELLED');
    }

    const { PrismaService } = await import('../database/prisma.service');
    const prisma = app.get(PrismaService);
    const stored = await prisma.workJob.findUnique({
      where: { id: jobBId },
      select: { status: true },
    });
    expect(stored ? stored.status : '').toBe('CANCELLED');

    const rows = await auditRows(jobBId);
    expect(rows).toHaveLength(1);
    expect([writerKeyId, writerTwoKeyId]).toContain(rows[0].metadata.apiKeyId);
  });
  it('lists jobs for a key with parity against the JWT surface', async () => {
    const listed = await genapiGet('applications/' + applicationIdA + '/jobs', readerKey);
    expect(listed.status).toBe(200);
    const items = listed.body as unknown as Array<{ id: string; applicationId: string; type: string; status: string }>;
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.id)).toEqual([jobBId, jobAId]);
    for (const item of items) {
      expect(item.applicationId).toBe(applicationIdA);
      expect(item.type).toBe('REQUIREMENTS_ANALYSIS');
      expect(item.status).toBe('CANCELLED');
    }

    const jwtListed = await api('GET', '/applications/' + applicationIdA + '/jobs', undefined, hank.tokens.accessToken);
    expect(jwtListed.status).toBe(200);
    expect(listed.body).toEqual(jwtListed.body);
  });

  it('filters the keyed job list by status with honest validation', async () => {
    const cancelled = await genapiGet('applications/' + applicationIdA + '/jobs?status=CANCELLED', readerKey);
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as unknown as Array<{ status: string }>).map((item) => item.status))
      .toEqual(['CANCELLED', 'CANCELLED']);

    const queued = await genapiGet('applications/' + applicationIdA + '/jobs?status=QUEUED', readerKey);
    expect(queued.status).toBe(200);
    expect(queued.body).toEqual([]);

    const succeeded = await genapiGet('applications/' + applicationIdA + '/jobs?status=SUCCEEDED', readerKey);
    expect(succeeded.status).toBe(200);
    expect(succeeded.body).toEqual([]);

    const jwtCancelled = await api('GET', '/applications/' + applicationIdA + '/jobs?status=CANCELLED', undefined, hank.tokens.accessToken);
    expect(jwtCancelled.status).toBe(200);
    expect(cancelled.body).toEqual(jwtCancelled.body);

    const refused = await genapiGet('applications/' + applicationIdA + '/jobs?status=BOGUS', readerKey);
    expect(refused.status).toBe(400);
    expect((refused.body as { message: string }).message).toBe('Job status filter must be one of the known job statuses.');

    const jwtRefused = await api('GET', '/applications/' + applicationIdA + '/jobs?status=BOGUS', undefined, hank.tokens.accessToken);
    expect(jwtRefused.status).toBe(400);
  });

  it('keeps the job list tenant-bounded behind a uniform 404', async () => {
    const probes = [
      ['applications/unknown-application-id/jobs', readerKey],
      ['applications/' + applicationIdB + '/jobs', readerKey],
      ['applications/' + applicationIdA + '/jobs', irisWriterKey],
    ] as Array<[string, string]>;
    const messages = new Set<string>();
    for (const [path, key] of probes) {
      const refused = await genapiGet(path, key);
      expect(refused.status).toBe(404);
      messages.add(String((refused.body as { message?: string }).message));
    }
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Application not found.');
  });

  it('races a keyed list against a keyed cancel without ever surfacing a 500', async () => {
    const graphC = await createGraph(hank, applicationIdA, 'List Race Graph');
    const jobCId = await planGraph(hank, graphC.id);

    const raced = await Promise.all([
      genapiGet('applications/' + applicationIdA + '/jobs?status=QUEUED', readerKey),
      genapiCancel(applicationIdA, jobCId, writerKey),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(201);
    expect((raced[1].body as { status: string }).status).toBe('CANCELLED');

    const { PrismaService } = await import('../database/prisma.service');
    const prisma = app.get(PrismaService);
    const stored = await prisma.workJob.findUnique({
      where: { id: jobCId },
      select: { status: true },
    });
    expect(stored ? stored.status : '').toBe('CANCELLED');

    const after = await genapiGet('applications/' + applicationIdA + '/jobs', readerKey);
    expect(after.status).toBe(200);
    const ids = (after.body as unknown as Array<{ id: string }>).map((item) => item.id);
    expect(ids).toEqual([jobCId, jobBId, jobAId]);

    const queuedNow = await genapiGet('applications/' + applicationIdA + '/jobs?status=QUEUED', readerKey);
    expect(queuedNow.status).toBe(200);
    expect(queuedNow.body).toEqual([]);
  });


  it('keeps keyed reads working on an archived application while cancel stays blocked', async () => {
    const archived = await api(
      'POST',
      '/projects/' + projectIdA + '/applications/' + applicationIdA + '/archive',
      {},
      hank.tokens.accessToken,
    );
    expect(archived.status).toBe(201);

    const graphs = await genapiGet('applications/' + applicationIdA + '/work-graphs', readerKey);
    expect(graphs.status).toBe(200);

    const graph = await genapiGet('applications/' + applicationIdA + '/work-graphs/' + graphIdA, readerKey);
    expect(graph.status).toBe(200);

    const validated = await genapiGet('applications/' + applicationIdA + '/work-graphs/' + graphIdA + '/validate', readerKey);
    expect(validated.status).toBe(200);

    const job = await genapiGet('applications/' + applicationIdA + '/jobs/' + jobAId, readerKey);
    expect(job.status).toBe(200);
    expect((job.body as { status: string }).status).toBe('CANCELLED');

    const jobList = await genapiGet('applications/' + applicationIdA + '/jobs', readerKey);
    expect(jobList.status).toBe(200);

    const refused = await genapiCancel(applicationIdA, jobAId, writerKey);
    expect(refused.status).toBe(404);
    expect(await auditRows(jobAId)).toHaveLength(1);
  });

  it('stops a revoked key instantly on reads and writes', async () => {
    const created = await createKey(hank.tokens.accessToken, organizationIdA, 'doomed', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    expect(created.status).toBe(201);
    const doomedKey = (created.body as { key: string }).key;
    const doomedKeyId = (created.body as { id: string }).id;

    const revoke = await api(
      'POST',
      '/organizations/' + organizationIdA + '/api-keys/' + doomedKeyId + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect(revoke.status).toBe(201);

    const read = await genapiGet('applications/' + applicationIdA + '/jobs/' + jobAId, doomedKey);
    expect(read.status).toBe(401);
    const write = await genapiCancel(applicationIdA, jobAId, doomedKey);
    expect(write.status).toBe(401);
    const listed = await genapiGet('applications/' + applicationIdA + '/jobs', doomedKey);
    expect(listed.status).toBe(401);
  });

  it('honors expiry on the async-work surface', async () => {
    const expiresAt = new Date(Date.now() + 2000).toISOString();
    const created = await createKey(
      hank.tokens.accessToken,
      organizationIdA,
      'fleeting',
      ['READ_APPLICATIONS'],
      expiresAt,
    );
    expect(created.status).toBe(201);
    const fleetingKey = (created.body as { key: string }).key;

    const before = await genapiGet('applications/' + applicationIdA + '/jobs/' + jobAId, fleetingKey);
    expect(before.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const after = await genapiGet('applications/' + applicationIdA + '/jobs/' + jobAId, fleetingKey);
    expect(after.status).toBe(401);

    const afterList = await genapiGet('applications/' + applicationIdA + '/jobs', fleetingKey);
    expect(afterList.status).toBe(401);
  });

  it('rejects missing credentials with a uniform 401 on every async-work endpoint', async () => {
    const reads = [
      'applications/' + applicationIdA + '/work-graphs',
      'applications/' + applicationIdA + '/work-graphs/' + graphIdA,
      'applications/' + applicationIdA + '/work-graphs/' + graphIdA + '/validate',
      'applications/' + applicationIdA + '/jobs',
      'applications/' + applicationIdA + '/jobs/' + jobAId,
    ];
    for (const path of reads) {
      const refused = await genapiGet(path, undefined);
      expect(refused.status).toBe(401);
    }
    const cancel = await genapiCancel(applicationIdA, jobAId, undefined);
    expect(cancel.status).toBe(401);
  });
});
