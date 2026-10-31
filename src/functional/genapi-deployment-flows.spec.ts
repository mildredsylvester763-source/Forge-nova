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
interface ApiResponse { status: number; body: Record<string, unknown>; }

/**
 * genapi deployment flows: the key-authenticated read surface for
 * readiness reports, deployment lists, and deployment inspect, proven
 * against the JWT surface with exact parity, uniform 404s, blocked
 * honesty, archived applications, revocation, expiry, missing
 * credentials, and races that must never surface a 500. Grounded in the
 * GitHub deployments read model: reading deployments needs only read
 * access. No mocks; the real app runs against the real CI PostgreSQL.
 */
suite('genapi key-authenticated deployment flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let hank: UserContext;
  let iris: UserContext;
  let projectIdA: string;
  let organizationIdA: string;
  let deployableAppId: string;
  let blockedAppId: string;
  let applicationIdB: string;
  let deploymentIdA1: string;
  let deploymentIdA2: string;
  let foreignDeploymentId: string;
  let readerKey: string;
  let writerOnlyKey: string;
  let irisReaderKey: string;
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

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const registerUser = async (name: string): Promise<UserContext> => {
    const email = 'genesis-deploy-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'genapi-deploy-test-password-123',
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

  const makeDeployable = async (owner: UserContext, applicationId: string) => {
    const page = await api(
      'POST',
      '/applications/' + applicationId + '/files',
      { path: 'index.html', content: '<!doctype html><html><body><h1>Deploy</h1></body></html>' },
      owner.tokens.accessToken,
    );
    expect(page.status).toBe(201);
    const verified = await api('POST', '/applications/' + applicationId + '/verifications', {}, owner.tokens.accessToken);
    expect(verified.status).toBe(201);
    const runs = verified.body as unknown as Array<{ status: string }>;
    expect(runs.length).toBe(3);
    runs.forEach((run) => expect(['PASSED', 'SKIPPED']).toContain(run.status));
  };

  const createDeployment = async (owner: UserContext, applicationId: string, environment: string) => {
    const deployment = await api(
      'POST',
      '/applications/' + applicationId + '/deployments',
      { environment },
      owner.tokens.accessToken,
    );
    expect(deployment.status).toBe(201);
    return deployment.body as { id: string };
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
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('seeds two tenants, a deployable app, a blocked app, deployments, and keys with distinct scopes', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const tenantA = await seedTenant(hank, 'Genapi Deploy Project', 'Genapi Deploy App');
    projectIdA = tenantA.projectId;
    organizationIdA = tenantA.organizationId;
    deployableAppId = tenantA.applicationId;

    const blocked = await api(
      'POST',
      '/projects/' + projectIdA + '/applications',
      { name: 'Blocked Deploy App' },
      hank.tokens.accessToken,
    );
    expect(blocked.status).toBe(201);
    blockedAppId = (blocked.body as { id: string }).id;

    await makeDeployable(hank, deployableAppId);

    const ready = await api('GET', '/applications/' + deployableAppId + '/deployments/readiness', undefined, hank.tokens.accessToken);
    expect(ready.status).toBe(200);
    expect((ready.body as { verdict: string }).verdict).toBe('READY');

    const blockedReadiness = await api('GET', '/applications/' + blockedAppId + '/deployments/readiness', undefined, hank.tokens.accessToken);
    expect(blockedReadiness.status).toBe(200);
    expect((blockedReadiness.body as { verdict: string }).verdict).toBe('BLOCKED');

    const first = await createDeployment(hank, deployableAppId, 'PREVIEW');
    deploymentIdA1 = first.id;
    const second = await createDeployment(hank, deployableAppId, 'STAGING');
    deploymentIdA2 = second.id;

    const tenantB = await seedTenant(iris, 'Iris Deploy Project', 'Iris Deploy App');
    applicationIdB = tenantB.applicationId;
    await makeDeployable(iris, applicationIdB);
    const foreign = await createDeployment(iris, applicationIdB, 'PREVIEW');
    foreignDeploymentId = foreign.id;

    const reader = await createKey(hank.tokens.accessToken, organizationIdA, 'reader', ['READ_APPLICATIONS']);
    expect(reader.status).toBe(201);
    readerKey = (reader.body as { key: string }).key;

    const writerOnly = await createKey(hank.tokens.accessToken, organizationIdA, 'writer-only', ['WRITE_APPLICATIONS']);
    expect(writerOnly.status).toBe(201);
    writerOnlyKey = (writerOnly.body as { key: string }).key;

    const irisReader = await createKey(iris.tokens.accessToken, tenantB.organizationId, 'iris-reader', ['READ_APPLICATIONS']);
    expect(irisReader.status).toBe(201);
    irisReaderKey = (irisReader.body as { key: string }).key;
  });

  it('reports readiness for a key with exact parity against the JWT surface', async () => {
    const keyed = await genapiGet('applications/' + deployableAppId + '/deployments/readiness', readerKey);
    const jwt = await api('GET', '/applications/' + deployableAppId + '/deployments/readiness', undefined, hank.tokens.accessToken);
    expect(keyed.status).toBe(200);
    expect(jwt.status).toBe(200);
    expect(keyed.body).toEqual(jwt.body);
    expect((keyed.body as { verdict: string }).verdict).toBe('READY');
  });

  it('lists deployments for a key with parity, newest first, never padded', async () => {
    const keyed = await genapiGet('applications/' + deployableAppId + '/deployments', readerKey);
    const jwt = await api('GET', '/applications/' + deployableAppId + '/deployments', undefined, hank.tokens.accessToken);
    expect(keyed.status).toBe(200);
    expect(jwt.status).toBe(200);
    expect(keyed.body).toEqual(jwt.body);
    const rows = keyed.body as unknown as Array<{ id: string }>;
    expect(rows.length).toBe(2);
    expect(rows[0].id).toBe(deploymentIdA2);
    expect(rows[1].id).toBe(deploymentIdA1);
  });

  it('inspects a deployment for a key with exact parity against the JWT surface', async () => {
    const keyed = await genapiGet('applications/' + deployableAppId + '/deployments/' + deploymentIdA1, readerKey);
    const jwt = await api('GET', '/applications/' + deployableAppId + '/deployments/' + deploymentIdA1, undefined, hank.tokens.accessToken);
    expect(keyed.status).toBe(200);
    expect(jwt.status).toBe(200);
    expect(keyed.body).toEqual(jwt.body);
    expect((keyed.body as { environment: string }).environment).toBe('PREVIEW');
  });

  it('keeps foreign and unknown deployments behind uniform 404s that never leak what exists', async () => {
    const deploymentProbes = [
      'applications/' + deployableAppId + '/deployments/nonexistent-deployment',
      'applications/' + deployableAppId + '/deployments/' + foreignDeploymentId,
    ];
    const deploymentMessages = new Set<string>();
    for (const path of deploymentProbes) {
      const probe = await genapiGet(path, readerKey);
      expect(probe.status).toBe(404);
      deploymentMessages.add((probe.body as { message: string }).message);
    }
    expect(deploymentMessages.size).toBe(1);
    expect([...deploymentMessages][0]).toBe('Deployment not found.');

    const appProbes = [
      'applications/' + applicationIdB + '/deployments/' + deploymentIdA1,
      'applications/nonexistent-application/deployments/' + deploymentIdA1,
      'applications/' + deployableAppId + '/deployments',
      'applications/' + deployableAppId + '/deployments/readiness',
    ];
    const appMessages = new Set<string>();
    for (const path of appProbes) {
      const probe = await genapiGet(path, irisReaderKey);
      expect(probe.status).toBe(404);
      appMessages.add((probe.body as { message: string }).message);
    }
    expect(appMessages.size).toBe(1);
    expect([...appMessages][0]).toBe('Application not found.');
  });

  it('refuses a write-only key on every deployment read and never writes audit rows for reads or refusals', async () => {
    const before = await prisma.auditEvent.count({
      where: {
        action: 'application.deployment.record',
        resourceId: { in: [deploymentIdA1, deploymentIdA2] },
      },
    });
    expect(before).toBe(2);

    const probes = await Promise.all([
      genapiGet('applications/' + deployableAppId + '/deployments/readiness', writerOnlyKey),
      genapiGet('applications/' + deployableAppId + '/deployments', writerOnlyKey),
      genapiGet('applications/' + deployableAppId + '/deployments/' + deploymentIdA1, writerOnlyKey),
    ]);
    probes.forEach((probe) => expect(probe.status).toBe(403));

    const after = await prisma.auditEvent.count({
      where: {
        action: 'application.deployment.record',
        resourceId: { in: [deploymentIdA1, deploymentIdA2] },
      },
    });
    expect(after).toBe(2);
  });

  it('reports a blocked application honestly on the key surface while the JWT write stays refused', async () => {
    const keyedReadiness = await genapiGet('applications/' + blockedAppId + '/deployments/readiness', readerKey);
    expect(keyedReadiness.status).toBe(200);
    expect((keyedReadiness.body as { verdict: string }).verdict).toBe('BLOCKED');

    const keyedList = await genapiGet('applications/' + blockedAppId + '/deployments', readerKey);
    expect(keyedList.status).toBe(200);
    expect(keyedList.body as unknown as Array<unknown>).toHaveLength(0);

    const jwtCreate = await api(
      'POST',
      '/applications/' + blockedAppId + '/deployments',
      { environment: 'PRODUCTION' },
      hank.tokens.accessToken,
    );
    expect(jwtCreate.status).toBe(400);
    expect((jwtCreate.body as { message: string }).message).toContain('Deployment blocked');
  });

  it('races a keyed list against a JWT deployment create and a keyed readiness against a JWT file write without ever surfacing a 500', async () => {
    const raceApp = await api(
      'POST',
      '/projects/' + projectIdA + '/applications',
      { name: 'Genapi Deploy Race App' },
      hank.tokens.accessToken,
    );
    expect(raceApp.status).toBe(201);
    const raceAppId = (raceApp.body as { id: string }).id;
    await makeDeployable(hank, raceAppId);

    const raced = await Promise.all([
      genapiGet('applications/' + raceAppId + '/deployments', readerKey),
      api('POST', '/applications/' + raceAppId + '/deployments', { environment: 'PREVIEW' }, hank.tokens.accessToken),
    ]);
    expect(raced[0].status).toBe(200);
    expect((raced[0].body as unknown as Array<unknown>).length).toBeLessThanOrEqual(1);
    expect(raced[1].status).toBe(201);

    const after = await genapiGet('applications/' + raceAppId + '/deployments', readerKey);
    expect(after.status).toBe(200);
    expect(after.body as unknown as Array<unknown>).toHaveLength(1);

    const racedTwo = await Promise.all([
      genapiGet('applications/' + raceAppId + '/deployments/readiness', readerKey),
      api(
        'POST',
        '/applications/' + raceAppId + '/files',
        { path: 'about.html', content: '<!doctype html><html><body><p>About</p></body></html>' },
        hank.tokens.accessToken,
      ),
    ]);
    expect(racedTwo[0].status).toBe(200);
    expect(typeof (racedTwo[0].body as { verdict: string }).verdict).toBe('string');
    expect(racedTwo[1].status).toBe(201);
  });

  it('keeps keyed deployment reads working on an archived application', async () => {
    const archive = await api(
      'POST',
      '/projects/' + projectIdA + '/applications/' + deployableAppId + '/archive',
      {},
      hank.tokens.accessToken,
    );
    expect(archive.status).toBe(201);

    const readiness = await genapiGet('applications/' + deployableAppId + '/deployments/readiness', readerKey);
    expect(readiness.status).toBe(200);
    expect((readiness.body as { verdict: string }).verdict).toBe('READY');

    const listed = await genapiGet('applications/' + deployableAppId + '/deployments', readerKey);
    expect(listed.status).toBe(200);
    expect(listed.body as unknown as Array<unknown>).toHaveLength(2);

    const inspected = await genapiGet('applications/' + deployableAppId + '/deployments/' + deploymentIdA1, readerKey);
    expect(inspected.status).toBe(200);
    expect((inspected.body as { id: string }).id).toBe(deploymentIdA1);
  });

  it('stops a revoked key instantly on deployment reads', async () => {
    const created = await createKey(hank.tokens.accessToken, organizationIdA, 'doomed', ['READ_APPLICATIONS']);
    expect(created.status).toBe(201);
    const doomedKey = (created.body as { key: string }).key;
    const doomedKeyId = (created.body as { id: string }).id;

    const revoke = await api('POST', '/organizations/' + organizationIdA + '/api-keys/' + doomedKeyId + '/revoke', {}, hank.tokens.accessToken);
    expect(revoke.status).toBe(201);

    const probes = await Promise.all([
      genapiGet('applications/' + blockedAppId + '/deployments/readiness', doomedKey),
      genapiGet('applications/' + blockedAppId + '/deployments', doomedKey),
      genapiGet('applications/' + blockedAppId + '/deployments/nonexistent-deployment', doomedKey),
    ]);
    probes.forEach((probe) => expect(probe.status).toBe(401));
  });

  it('honors expiry on the deployment surface', async () => {
    const expiresAt = new Date(Date.now() + 2000).toISOString();
    const created = await createKey(hank.tokens.accessToken, organizationIdA, 'expiring', ['READ_APPLICATIONS'], expiresAt);
    expect(created.status).toBe(201);
    const expiringKey = (created.body as { key: string }).key;

    await sleep(2500);

    const probes = await Promise.all([
      genapiGet('applications/' + blockedAppId + '/deployments/readiness', expiringKey),
      genapiGet('applications/' + blockedAppId + '/deployments', expiringKey),
      genapiGet('applications/' + blockedAppId + '/deployments/nonexistent-deployment', expiringKey),
    ]);
    probes.forEach((probe) => expect(probe.status).toBe(401));
  });

  it('rejects missing credentials with a uniform 401 on every deployment endpoint', async () => {
    const probes = await Promise.all([
      genapiGet('applications/' + blockedAppId + '/deployments/readiness', undefined),
      genapiGet('applications/' + blockedAppId + '/deployments', undefined),
      genapiGet('applications/' + blockedAppId + '/deployments/nonexistent-deployment', undefined),
    ]);
    probes.forEach((probe) => expect(probe.status).toBe(401));
  });
});
