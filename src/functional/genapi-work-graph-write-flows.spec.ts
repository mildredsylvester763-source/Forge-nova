import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WorkGraphStatus } from '@prisma/client';
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
interface ApiResponse { status: number; body: Record<string, unknown>; }

/**
 * Key-authenticated work graph writes against the real app and the
 * real CI PostgreSQL: graph create and node add. Grounded in the
 * market leaders: the Vercel project create builds a new resource
 * straight from a Bearer access token with only the name required,
 * and the GitHub deployment status create lets a token with push
 * access add child records to a parent resource behind write
 * permission, with concurrent writes warned to conflict. The keyed
 * routes mirror the JWT routes exactly: the same seeded original
 * user request node, the same risk laws, the same honest 409s and
 * 400s, tenant-bounded with uniform 404s, and no audit rows because
 * the JWT work graph surface writes none either.
 */
suite('GENESIS genapi work graph write flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId: string;
  let foreignOrganizationId: string;
  let mainProjectId: string;
  let applicationAId: string;
  let applicationBId: string;
  let foreignApplicationId: string;
  let writerKey: KeyContext;
  let writerKeyTwo: KeyContext;
  let readerKey: KeyContext;
  let shortLivedKey: KeyContext;
  let revokedKey: KeyContext;
  let irisWriter: KeyContext;
  const createdUserIds: string[] = [];
  const createdGraphIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);

  const api = async (
    method: string,
    requestPath: string,
    body: unknown = undefined,
    accessToken?: string,
  ): Promise<ApiResponse> => {
    const response = await fetch(baseUrl + requestPath, {
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
    const email = 'genesis-graphw-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'work-graph-password-123',
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
    orgId: string,
    name: string,
    scopes: string[],
    expiresAt?: string,
  ): Promise<KeyContext> => {
    const body: Record<string, unknown> = { name, scopes };
    if (expiresAt !== undefined) {
      body.expiresAt = expiresAt;
    }
    const response = await api('POST', '/organizations/' + orgId + '/api-keys', body, token);
    expect(response.status).toBe(201);
    const created = response.body as unknown as KeyContext;
    expect(created.key).toMatch(/^gn_live_[A-Za-z0-9_-]{43}$/);
    return created;
  };

  const createProject = async (token: string, workspaceId: string, name: string) => {
    const response = await api('POST', '/workspaces/' + workspaceId + '/projects', { name }, token);
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  };

  const createApplication = async (token: string, projectId: string, name: string) => {
    const response = await api('POST', '/projects/' + projectId + '/applications', { name }, token);
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  };

  const createGraphKeyed = (applicationId: string, title: string, sourcePrompt: string, key?: string) =>
    api(
      'POST',
      '/genapi/applications/' + applicationId + '/work-graphs',
      { title, sourcePrompt },
      key,
    );

  const createGraphJwt = (applicationId: string, title: string, sourcePrompt: string) =>
    api(
      'POST',
      '/applications/' + applicationId + '/work-graphs',
      { title, sourcePrompt },
      hank.tokens.accessToken,
    );

  const addNodeKeyed = (
    applicationId: string,
    graphId: string,
    body: Record<string, unknown>,
    key?: string,
  ) =>
    api(
      'POST',
      '/genapi/applications/' + applicationId + '/work-graphs/' + graphId + '/nodes',
      body,
      key,
    );

  const addNodeJwt = (graphId: string, body: Record<string, unknown>) =>
    api('POST', '/work-graphs/' + graphId + '/nodes', body, hank.tokens.accessToken);

  const readGraphKeyed = (applicationId: string, graphId: string, key?: string) =>
    api('GET', '/genapi/applications/' + applicationId + '/work-graphs/' + graphId, undefined, key);

  const trackGraph = (graphId: string) => {
    createdGraphIds.push(graphId);
    return graphId;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({}).compile();
    await moduleRef.close();

    const { AppModule } = await import('../app.module');
    const testing = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    const server = app.getHttpServer() as { address: () => { port: number } };
    baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/v1';
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (createdGraphIds.length > 0) {
      await prisma.workDependency.deleteMany({
        where: {
          OR: [
            { fromNode: { graphId: { in: createdGraphIds } } },
            { toNode: { graphId: { in: createdGraphIds } } },
          ],
        },
      });
      await prisma.workNode.deleteMany({ where: { graphId: { in: createdGraphIds } } });
      await prisma.workGraph.deleteMany({ where: { id: { in: createdGraphIds } } });
    }
    if (typeof organizationId === 'string' && typeof foreignOrganizationId === 'string') {
      await prisma.auditEvent.deleteMany({
        where: { organizationId: { in: [organizationId, foreignOrganizationId] } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('seeds two organizations, applications, and scoped keys', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankWorkspaces = await api('GET', '/workspaces', undefined, hank.tokens.accessToken);
    expect(hankWorkspaces.status).toBe(200);
    const workspaceAId = (hankWorkspaces.body as unknown as Array<{ id: string }>)[0].id;

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;
    expect(foreignOrganizationId).not.toBe(organizationId);

    const irisWorkspaces = await api('GET', '/workspaces', undefined, iris.tokens.accessToken);
    expect(irisWorkspaces.status).toBe(200);
    const foreignWorkspaceId = (irisWorkspaces.body as unknown as Array<{ id: string }>)[0].id;

    mainProjectId = await createProject(hank.tokens.accessToken, workspaceAId, 'Graph Write Project ' + runId);
    const foreignProjectId = await createProject(iris.tokens.accessToken, foreignWorkspaceId, 'Foreign Graph Write Project ' + runId);

    applicationAId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Graphw App A ' + runId);
    applicationBId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Graphw App B ' + runId);
    foreignApplicationId = await createApplication(iris.tokens.accessToken, foreignProjectId, 'Foreign Graphw App ' + runId);

    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'Graphw Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
    writerKeyTwo = await createKey(hank.tokens.accessToken, organizationId, 'Graphw Writer Two', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
    readerKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Graphw Reader',
      ['READ_APPLICATIONS'],
    );
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Graphw Short Lived',
      ['WRITE_APPLICATIONS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Graphw Revoked',
      ['WRITE_APPLICATIONS'],
    );
    irisWriter = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Foreign Graphw Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
  });

  it('creates graphs through the keyed surface and mirrors the JWT create', async () => {
    const keyed = await createGraphKeyed(
      applicationAId,
      'Graphw Keyed ' + runId,
      'Build and deploy the checkout service',
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    const keyedGraphId = trackGraph((keyed.body as { id: string }).id);

    const jwt = await createGraphJwt(applicationAId, 'Graphw Jwt ' + runId, 'Build and deploy the search service');
    expect(jwt.status).toBe(201);
    trackGraph((jwt.body as { id: string }).id);

    const expectedKeys = ['applicationId', 'createdAt', 'id', 'nodes', 'sourcePrompt', 'status', 'title', 'version'];
    expect(Object.keys(keyed.body).sort()).toEqual(expectedKeys);
    expect(Object.keys(jwt.body).sort()).toEqual(expectedKeys);

    expect((keyed.body as { status: string }).status).toBe('DRAFT');
    expect((keyed.body as { version: number }).version).toBe(1);
    expect((keyed.body as { title: string }).title).toBe('Graphw Keyed ' + runId);

    const keyedNodes = ((keyed.body as { nodes: unknown }).nodes as unknown as Array<{ key: string; type: string; status: string }>);
    expect(keyedNodes.length).toBe(1);
    expect(keyedNodes[0].key).toBe('user-request');
    expect(keyedNodes[0].type).toBe('REQUIREMENT');
    expect(keyedNodes[0].status).toBe('RECORDED');

    const jwtNodes = ((jwt.body as { nodes: unknown }).nodes as unknown as Array<{ key: string }>);
    expect(jwtNodes.map((node) => node.key)).toEqual(keyedNodes.map((node) => node.key));

    const row = await prisma.workGraph.findUnique({
      where: { id: keyedGraphId },
      select: { createdBy: true, applicationId: true },
    });
    expect(row!.createdBy).toBe(hank.userId);
    expect(row!.applicationId).toBe(applicationAId);
  });

  it('adds nodes through the keyed surface and mirrors the JWT addNode', async () => {
    const graphId = trackGraph(
      ((await createGraphKeyed(applicationAId, 'Graphw Parity ' + runId, 'Plan the parity work', writerKey.key)).body as { id: string }).id,
    );
    const jwtGraphId = trackGraph(
      ((await createGraphJwt(applicationAId, 'Graphw Parity Jwt ' + runId, 'Plan the jwt parity work')).body as { id: string }).id,
    );

    const buildBody: Record<string, unknown> = { key: 'build-1', type: 'BUILD', title: 'Build the service' };
    const keyed = await addNodeKeyed(applicationAId, graphId, buildBody, writerKey.key);
    expect(keyed.status).toBe(201);
    expect(Object.keys(keyed.body).sort()).toEqual([
      'createdAt', 'graphId', 'id', 'key', 'requiresApproval', 'riskLevel', 'status', 'title', 'type',
    ]);
    expect((keyed.body as { riskLevel: string }).riskLevel).toBe('MEDIUM');
    expect((keyed.body as { requiresApproval: boolean }).requiresApproval).toBe(false);
    expect((keyed.body as { status: string }).status).toBe('PENDING');
    expect((keyed.body as { graphId: string }).graphId).toBe(graphId);

    const jwt = await addNodeJwt(jwtGraphId, buildBody);
    expect(jwt.status).toBe(201);
    expect(Object.keys(jwt.body).sort()).toEqual(Object.keys(keyed.body).sort());
    expect((jwt.body as { riskLevel: string }).riskLevel).toBe('MEDIUM');

    const deploy = await addNodeKeyed(applicationAId, graphId, {
      key: 'deploy-1',
      type: 'DEPLOY',
      title: 'Deploy the service',
    }, writerKey.key);
    expect(deploy.status).toBe(201);
    expect((deploy.body as { riskLevel: string }).riskLevel).toBe('HIGH');
    expect((deploy.body as { requiresApproval: boolean }).requiresApproval).toBe(true);

    const inspect = await readGraphKeyed(applicationAId, graphId, readerKey.key);
    expect(inspect.status).toBe(200);
    expect((inspect.body as { version: number }).version).toBe(3);
    const nodes = ((inspect.body as { nodes: unknown }).nodes as unknown as Array<{ key: string }>);
    expect(nodes.map((node) => node.key).sort()).toEqual(['build-1', 'deploy-1', 'user-request']);
  });

  it('wires a valid dependency through the keyed surface', async () => {
    const graphId = trackGraph(
      ((await createGraphKeyed(applicationAId, 'Graphw Dependency ' + runId, 'Plan the dependency work', writerKey.key)).body as { id: string }).id,
    );
    const deploy = await addNodeKeyed(applicationAId, graphId, {
      key: 'deploy-dep',
      type: 'DEPLOY',
      title: 'Deploy after build',
    }, writerKey.key);
    expect(deploy.status).toBe(201);
    const deployNodeId = (deploy.body as { id: string }).id;

    const verify = await addNodeKeyed(applicationAId, graphId, {
      key: 'verify-dep',
      type: 'VERIFY',
      title: 'Verify the deploy',
      dependsOnNodeIds: [deployNodeId],
    }, writerKey.key);
    expect(verify.status).toBe(201);

    const edges = await prisma.workDependency.count({
      where: { toNodeId: (verify.body as { id: string }).id },
    });
    expect(edges).toBe(1);
  });

  it('refuses duplicate node keys with the honest 409 on both surfaces', async () => {
    const graphId = trackGraph(
      ((await createGraphKeyed(applicationAId, 'Graphw Duplicate ' + runId, 'Plan the duplicate work', writerKey.key)).body as { id: string }).id,
    );
    const jwtGraphId = trackGraph(
      ((await createGraphJwt(applicationAId, 'Graphw Duplicate Jwt ' + runId, 'Plan the jwt duplicate work')).body as { id: string }).id,
    );

    const first = await addNodeKeyed(applicationAId, graphId, {
      key: 'dup-1',
      type: 'TEST',
      title: 'First duplicate probe',
    }, writerKey.key);
    expect(first.status).toBe(201);

    const second = await addNodeKeyed(applicationAId, graphId, {
      key: 'dup-1',
      type: 'TEST',
      title: 'Second duplicate probe',
    }, writerKey.key);
    expect(second.status).toBe(409);
    expect((second.body as { message: string }).message).toBe('A work node with this key already exists in this graph.');

    const jwtFirst = await addNodeJwt(jwtGraphId, { key: 'dup-j', type: 'TEST', title: 'Jwt duplicate probe' });
    expect(jwtFirst.status).toBe(201);
    const jwtSecond = await addNodeJwt(jwtGraphId, { key: 'dup-j', type: 'TEST', title: 'Jwt duplicate probe again' });
    expect(jwtSecond.status).toBe(409);
    expect((jwtSecond.body as { message: string }).message).toBe('A work node with this key already exists in this graph.');

    const stored = await prisma.workNode.count({ where: { graphId, key: 'dup-1' } });
    expect(stored).toBe(1);
  });

  it('refuses unknown dependencies with the uniform 400', async () => {
    const graphId = trackGraph(
      ((await createGraphKeyed(applicationAId, 'Graphw Bad Dep ' + runId, 'Plan the bad dependency work', writerKey.key)).body as { id: string }).id,
    );

    const refused = await addNodeKeyed(applicationAId, graphId, {
      key: 'bad-dep',
      type: 'TEST',
      title: 'Node with a broken dependency',
      dependsOnNodeIds: ['does-not-exist-at-all'],
    }, writerKey.key);
    expect(refused.status).toBe(400);
    expect((refused.body as { message: string }).message).toBe('Every dependency must refer to a node in this work graph.');

    const stored = await prisma.workNode.count({ where: { graphId, key: 'bad-dep' } });
    expect(stored).toBe(0);
  });

  it('refuses secrets in the source prompt and node input with zero rows', async () => {
    const secretPrompt = 'Deploy using AKIAIOSFODNN7EXAMPLE before Friday';
    const refusedCreate = await createGraphKeyed(applicationAId, 'Graphw Secret ' + runId, secretPrompt, writerKey.key);
    expect(refusedCreate.status).toBe(400);
    const createdGraphs = await prisma.workGraph.count({
      where: { applicationId: applicationAId, title: 'Graphw Secret ' + runId },
    });
    expect(createdGraphs).toBe(0);

    const graphId = trackGraph(
      ((await createGraphKeyed(applicationAId, 'Graphw Secret Node ' + runId, 'Plan the secret scan work', writerKey.key)).body as { id: string }).id,
    );
    const refusedNode = await addNodeKeyed(applicationAId, graphId, {
      key: 'secret-node',
      type: 'BUILD',
      title: 'Node carrying a secret',
      input: { apiKey: 'AKIAIOSFODNN7EXAMPLE' },
    }, writerKey.key);
    expect(refusedNode.status).toBe(400);
    const stored = await prisma.workNode.count({ where: { graphId, key: 'secret-node' } });
    expect(stored).toBe(0);
  });

  it('lands exactly one node on an addNode double-tap', async () => {
    const graphId = trackGraph(
      ((await createGraphKeyed(applicationAId, 'Graphw Double Tap ' + runId, 'Plan the double tap work', writerKey.key)).body as { id: string }).id,
    );
    const body: Record<string, unknown> = { key: 'tap-1', type: 'BUILD', title: 'Double tap probe' };

    const raced = await Promise.all([
      addNodeKeyed(applicationAId, graphId, body, writerKey.key),
      addNodeKeyed(applicationAId, graphId, body, writerKey.key),
    ]);
    const statuses = raced.map((outcome) => outcome.status);
    expect(statuses.filter((status) => status === 201).length).toBe(1);
    expect(statuses.every((status) => status === 201 || status === 409)).toBe(true);

    const loser = raced.find((outcome) => outcome.status !== 201)!;
    const loserMessage = (loser.body as { message: string }).message;
    expect(
      loserMessage === 'A work node with this key already exists in this graph.'
      || loserMessage === 'The work graph changed concurrently. Reload it and retry.',
    ).toBe(true);

    const stored = await prisma.workNode.count({ where: { graphId, key: 'tap-1' } });
    expect(stored).toBe(1);
    const row = await prisma.workGraph.findUnique({ where: { id: graphId }, select: { version: true } });
    expect(row!.version).toBe(2);
  });

  it('races two keys adding different nodes into clean outcomes', async () => {
    const graphId = trackGraph(
      ((await createGraphKeyed(applicationAId, 'Graphw Two Keys ' + runId, 'Plan the two key race work', writerKey.key)).body as { id: string }).id,
    );

    const raced = await Promise.all([
      addNodeKeyed(applicationAId, graphId, { key: 'race-a', type: 'BUILD', title: 'Race probe A' }, writerKey.key),
      addNodeKeyed(applicationAId, graphId, { key: 'race-b', type: 'TEST', title: 'Race probe B' }, writerKeyTwo.key),
    ]);
    const statuses = raced.map((outcome) => outcome.status);
    expect(statuses.every((status) => status === 201 || status === 409)).toBe(true);
    const successes = statuses.filter((status) => status === 201).length;
    expect(successes).toBeGreaterThanOrEqual(1);

    const stored = await prisma.workNode.count({
      where: { graphId, key: { in: ['race-a', 'race-b'] } },
    });
    expect(stored).toBe(successes);
  });

  it('refuses node adds after execution has started', async () => {
    const graphId = trackGraph(
      ((await createGraphKeyed(applicationAId, 'Graphw Started ' + runId, 'Plan the started graph work', writerKey.key)).body as { id: string }).id,
    );
    await prisma.workGraph.update({
      where: { id: graphId },
      data: { status: WorkGraphStatus.PLANNING },
    });

    const keyed = await addNodeKeyed(applicationAId, graphId, {
      key: 'late-node',
      type: 'BUILD',
      title: 'Node added too late',
    }, writerKey.key);
    expect(keyed.status).toBe(409);
    expect((keyed.body as { message: string }).message).toBe('Nodes cannot be added after graph execution has started.');

    const jwt = await addNodeJwt(graphId, { key: 'late-node-jwt', type: 'BUILD', title: 'Jwt node added too late' });
    expect(jwt.status).toBe(409);
    expect((jwt.body as { message: string }).message).toBe('Nodes cannot be added after graph execution has started.');

    const stored = await prisma.workNode.count({ where: { graphId, key: { in: ['late-node', 'late-node-jwt'] } } });
    expect(stored).toBe(0);
  });

  it('tenant-bounds both routes with two uniform 404s', async () => {
    const applicationMessages = new Set<string>();
    const graphMessages = new Set<string>();

    const foreignKeyCreate = await createGraphKeyed(
      applicationAId,
      'Graphw Foreign Probe ' + runId,
      'Probe from a foreign key',
      irisWriter.key,
    );
    expect(foreignKeyCreate.status).toBe(404);
    applicationMessages.add((foreignKeyCreate.body as { message: string }).message);

    const foreignApplicationCreate = await createGraphKeyed(
      foreignApplicationId,
      'Graphw Foreign App Probe ' + runId,
      'Probe into a foreign application',
      writerKey.key,
    );
    expect(foreignApplicationCreate.status).toBe(404);
    applicationMessages.add((foreignApplicationCreate.body as { message: string }).message);

    const unknownApplicationCreate = await createGraphKeyed(
      'does-not-exist-at-all',
      'Graphw Unknown App Probe ' + runId,
      'Probe into an unknown application',
      writerKey.key,
    );
    expect(unknownApplicationCreate.status).toBe(404);
    applicationMessages.add((unknownApplicationCreate.body as { message: string }).message);

    const ownGraphId = trackGraph(
      ((await createGraphKeyed(applicationAId, 'Graphw Tenant ' + runId, 'Plan the tenant probe work', writerKey.key)).body as { id: string }).id,
    );

    const foreignKeyAdd = await addNodeKeyed(applicationAId, ownGraphId, {
      key: 'tenant-node',
      type: 'BUILD',
      title: 'Tenant probe node',
    }, irisWriter.key);
    expect(foreignKeyAdd.status).toBe(404);
    applicationMessages.add((foreignKeyAdd.body as { message: string }).message);

    const foreignApplicationAdd = await addNodeKeyed(foreignApplicationId, ownGraphId, {
      key: 'tenant-node',
      type: 'BUILD',
      title: 'Tenant probe node',
    }, writerKey.key);
    expect(foreignApplicationAdd.status).toBe(404);
    applicationMessages.add((foreignApplicationAdd.body as { message: string }).message);

    const unknownGraphAdd = await addNodeKeyed(applicationAId, 'does-not-exist-at-all', {
      key: 'tenant-node',
      type: 'BUILD',
      title: 'Unknown graph probe node',
    }, writerKey.key);
    expect(unknownGraphAdd.status).toBe(404);
    graphMessages.add((unknownGraphAdd.body as { message: string }).message);

    const crossApplicationAdd = await addNodeKeyed(applicationBId, ownGraphId, {
      key: 'tenant-node',
      type: 'BUILD',
      title: 'Cross application probe node',
    }, writerKey.key);
    expect(crossApplicationAdd.status).toBe(404);
    graphMessages.add((crossApplicationAdd.body as { message: string }).message);

    expect(applicationMessages.size).toBe(1);
    expect(Array.from(applicationMessages)[0]).toBe('Application not found.');
    expect(graphMessages.size).toBe(1);
    expect(Array.from(graphMessages)[0]).toBe('Work graph not found.');

    const stored = await prisma.workNode.count({ where: { graphId: ownGraphId, key: 'tenant-node' } });
    expect(stored).toBe(0);
  });

  it('lets a read-only key read the graph but refuse both writes with one message', async () => {
    const ownGraphId = trackGraph(
      ((await createGraphKeyed(applicationAId, 'Graphw Reader Probe ' + runId, 'Plan the reader probe work', writerKey.key)).body as { id: string }).id,
    );

    const readable = await readGraphKeyed(applicationAId, ownGraphId, readerKey.key);
    expect(readable.status).toBe(200);

    const refusedCreate = await createGraphKeyed(
      applicationAId,
      'Graphw Reader Create ' + runId,
      'Probe from a read-only key',
      readerKey.key,
    );
    expect(refusedCreate.status).toBe(403);
    expect((refusedCreate.body as { message: string }).message).toBe('The API key does not grant the required scope.');

    const refusedAdd = await addNodeKeyed(applicationAId, ownGraphId, {
      key: 'reader-node',
      type: 'BUILD',
      title: 'Reader probe node',
    }, readerKey.key);
    expect(refusedAdd.status).toBe(403);
    expect((refusedAdd.body as { message: string }).message).toBe('The API key does not grant the required scope.');
  });

  it('refuses keyed writes on archived applications with the uniform 404', async () => {
    const graphId = trackGraph(
      ((await createGraphKeyed(applicationBId, 'Graphw Archive Probe ' + runId, 'Plan the archive probe work', writerKey.key)).body as { id: string }).id,
    );

    const archiveApplication = await api(
      'POST',
      '/projects/' + mainProjectId + '/applications/' + applicationBId + '/archive',
      {},
      hank.tokens.accessToken,
    );
    expect(archiveApplication.status).toBe(201);

    const refusedCreate = await createGraphKeyed(
      applicationBId,
      'Graphw Archive Create ' + runId,
      'Probe into an archived application',
      writerKey.key,
    );
    expect(refusedCreate.status).toBe(404);
    expect((refusedCreate.body as { message: string }).message).toBe('Application not found.');

    const refusedAdd = await addNodeKeyed(applicationBId, graphId, {
      key: 'archive-node',
      type: 'BUILD',
      title: 'Archived probe node',
    }, writerKey.key);
    expect(refusedAdd.status).toBe(404);
    expect((refusedAdd.body as { message: string }).message).toBe('Application not found.');

    const stored = await prisma.workNode.count({ where: { graphId, key: 'archive-node' } });
    expect(stored).toBe(0);
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const ownGraphId = trackGraph(
      ((await createGraphKeyed(applicationAId, 'Graphw Lifecycle ' + runId, 'Plan the lifecycle probe work', writerKey.key)).body as { id: string }).id,
    );

    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect([200, 201]).toContain(revoke.status);

    const revokedCreate = await createGraphKeyed(
      applicationAId,
      'Graphw Revoked Probe ' + runId,
      'Probe from a revoked key',
      revokedKey.key,
    );
    expect(revokedCreate.status).toBe(401);
    expect((revokedCreate.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredAdd = await addNodeKeyed(applicationAId, ownGraphId, {
      key: 'expired-node',
      type: 'BUILD',
      title: 'Expired probe node',
    }, shortLivedKey.key);
    expect(expiredAdd.status).toBe(401);
    expect((expiredAdd.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const unauthenticatedCreate = await createGraphKeyed(
      applicationAId,
      'Graphw Unauth Probe ' + runId,
      'Probe without any key',
    );
    expect(unauthenticatedCreate.status).toBe(401);
    expect((unauthenticatedCreate.body as { message: string }).message).toBe('A valid GENESIS API key is required.');

    const unauthenticatedAdd = await addNodeKeyed(applicationAId, ownGraphId, {
      key: 'unauth-node',
      type: 'BUILD',
      title: 'Unauthenticated probe node',
    });
    expect(unauthenticatedAdd.status).toBe(401);
    expect((unauthenticatedAdd.body as { message: string }).message).toBe('A valid GENESIS API key is required.');

    const stored = await prisma.workGraph.count({
      where: { applicationId: applicationAId, title: { in: ['Graphw Revoked Probe ' + runId, 'Graphw Unauth Probe ' + runId] } },
    });
    expect(stored).toBe(0);
    const storedNodes = await prisma.workNode.count({
      where: { graphId: ownGraphId, key: { in: ['expired-node', 'unauth-node'] } },
    });
    expect(storedNodes).toBe(0);
  });

  it('writes zero audit rows for the keyed work graph surface', async () => {
    const before = await prisma.auditEvent.count({ where: { organizationId } });

    const graphId = trackGraph(
      ((await createGraphKeyed(applicationAId, 'Graphw Audit ' + runId, 'Plan the audit probe work', writerKey.key)).body as { id: string }).id,
    );
    const added = await addNodeKeyed(applicationAId, graphId, {
      key: 'audit-node',
      type: 'BUILD',
      title: 'Audit probe node',
    }, writerKey.key);
    expect(added.status).toBe(201);

    const refused = await addNodeKeyed(applicationAId, graphId, {
      key: 'audit-node',
      type: 'BUILD',
      title: 'Audit probe node again',
    }, writerKey.key);
    expect(refused.status).toBe(409);

    const after = await prisma.auditEvent.count({ where: { organizationId } });
    expect(after).toBe(before);
  });
});
