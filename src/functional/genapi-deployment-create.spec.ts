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
interface ApiResponse { status: number; body: Record<string, unknown>; }

/**
 * Keyed deployment create over the real app and the real CI
 * PostgreSQL. Grounded in the GitHub create-a-deployment REST
 * surface, where a fine-grained token needs the Deployments
 * repository permission set to write, never read: a deployment is
 * an honest intent that fires the deployment event for external
 * executors, and GitHub never claims execution. The keyed create
 * shares the one createForActor core with the JWT route, so the
 * readiness gate, the honest BLOCKED 400 report, the
 * none-configured adapter disclaimer, and the audit row law can
 * never drift apart between the two surfaces. Every count and
 * audit assertion is anchored in prisma ground truth scoped by
 * organizationId, because Jest workers share the CI PostgreSQL.
 */
suite('GENESIS keyed deployment create flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId = '';
  let foreignOrganizationId = '';
  let setupKey: KeyContext;
  let deployKey: KeyContext;
  let readerKey: KeyContext;
  let shortLivedKey: KeyContext;
  let revokedKey: KeyContext;
  let irisSetupKey: KeyContext;
  let irisWriterKey: KeyContext;
  let workspaceId = '';
  let projectId = '';
  let mainAppId = '';
  let blockedAppId = '';
  let archivedAppId = '';
  let irisWorkspaceId = '';
  let irisProjectId = '';
  let irisAppId = '';
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);
  const password = 'gdc-deploy-create-password-123';

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
    const email = 'genesis-gdc-' + name + '-' + runId + '@example.com';
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
    const response = await api(
      'POST',
      '/organizations/' + orgId + '/api-keys',
      { name, scopes, ...(expiresAt ? { expiresAt } : {}) },
      accessToken,
    );
    expect(response.status).toBe(201);
    const body = response.body as { id: string; key: string };
    expect(body.key).toMatch(/^gn_live_[A-Za-z0-9_-]{43}$/);
    return { id: body.id, key: body.key };
  };

  const auditCount = (orgId: string) => prisma.auditEvent.count({ where: { organizationId: orgId } });

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
    const orgIds = [organizationId, foreignOrganizationId].filter((id) => id !== '');
    if (orgIds.length > 0) {
      await prisma.auditEvent.deleteMany({ where: { organizationId: { in: orgIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('seeds two organizations, a key rack, and three applications', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;

    setupKey = await createKey(hank.tokens.accessToken, organizationId, 'Setup', ['READ_ORGANIZATION', 'READ_PROJECTS', 'WRITE_PROJECTS']);
    deployKey = await createKey(hank.tokens.accessToken, organizationId, 'Deployer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    readerKey = await createKey(hank.tokens.accessToken, organizationId, 'App Reader', ['READ_APPLICATIONS']);
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Short Lived',
      ['WRITE_APPLICATIONS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(hank.tokens.accessToken, organizationId, 'Revoked', ['WRITE_APPLICATIONS']);
    irisSetupKey = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Iris Setup', ['READ_ORGANIZATION', 'WRITE_PROJECTS']);
    irisWriterKey = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Iris Writer', ['WRITE_APPLICATIONS']);

    const workspaces = await api('GET', '/genapi/workspaces', undefined, setupKey.key);
    expect(workspaces.status).toBe(200);
    workspaceId = (workspaces.body as unknown as Array<{ id: string }>)[0].id;

    const project = await api('POST', '/genapi/workspaces/' + workspaceId + '/projects', { name: 'Deploy Yard' }, setupKey.key);
    expect(project.status).toBe(201);
    projectId = (project.body as { id: string }).id;

    const mainApp = await api('POST', '/genapi/projects/' + projectId + '/applications', { name: 'Main App' }, deployKey.key);
    expect(mainApp.status).toBe(201);
    mainAppId = (mainApp.body as { id: string }).id;

    const blockedApp = await api('POST', '/genapi/projects/' + projectId + '/applications', { name: 'Blocked App' }, deployKey.key);
    expect(blockedApp.status).toBe(201);
    blockedAppId = (blockedApp.body as { id: string }).id;

    const archivedApp = await api('POST', '/genapi/projects/' + projectId + '/applications', { name: 'Archived App' }, deployKey.key);
    expect(archivedApp.status).toBe(201);
    archivedAppId = (archivedApp.body as { id: string }).id;

    const mainFile = await api(
      'POST',
      '/genapi/applications/' + mainAppId + '/files',
      { path: 'index.html', content: '<html><body><h1>Genesis</h1></body></html>' },
      deployKey.key,
    );
    expect(mainFile.status).toBe(201);

    const archivedFile = await api(
      'POST',
      '/genapi/applications/' + archivedAppId + '/files',
      { path: 'index.html', content: '<html><body><h1>Genesis</h1></body></html>' },
      deployKey.key,
    );
    expect(archivedFile.status).toBe(201);

    const mainReadiness = await api('GET', '/genapi/applications/' + mainAppId + '/deployments/readiness', undefined, deployKey.key);
    expect(mainReadiness.status).toBe(200);
    expect((mainReadiness.body as { verdict: string }).verdict).toBe('NEEDS_REVIEW');

    const blockedReadiness = await api('GET', '/genapi/applications/' + blockedAppId + '/deployments/readiness', undefined, deployKey.key);
    expect(blockedReadiness.status).toBe(200);
    expect((blockedReadiness.body as { verdict: string }).verdict).toBe('BLOCKED');

    const irisWorkspaces = await api('GET', '/genapi/workspaces', undefined, irisSetupKey.key);
    expect(irisWorkspaces.status).toBe(200);
    irisWorkspaceId = (irisWorkspaces.body as unknown as Array<{ id: string }>)[0].id;

    const irisProject = await api('POST', '/genapi/workspaces/' + irisWorkspaceId + '/projects', { name: 'Iris Yard' }, irisSetupKey.key);
    expect(irisProject.status).toBe(201);
    irisProjectId = (irisProject.body as { id: string }).id;

    const irisApp = await api('POST', '/genapi/projects/' + irisProjectId + '/applications', { name: 'Iris App' }, irisWriterKey.key);
    expect(irisApp.status).toBe(201);
    irisAppId = (irisApp.body as { id: string }).id;
  });

  it('records the keyed deployment intent with the honest shape', async () => {
    const before = await auditCount(organizationId);

    const keyed = await api(
      'POST',
      '/genapi/applications/' + mainAppId + '/deployments',
      { environment: 'PRODUCTION', target: 'vercel', notes: 'ship it' },
      deployKey.key,
    );
    expect(keyed.status).toBe(201);
    const keyedRow = keyed.body as unknown as {
      id: string;
      applicationId: string;
      environment: string;
      provider: string | null;
      status: string;
      metadata: {
        readiness: { verdict: string };
        fileCount: number;
        adapter: string;
        executionNote: string;
        notes: string | null;
      };
    };
    expect(typeof keyedRow.id).toBe('string');
    expect(keyedRow.applicationId).toBe(mainAppId);
    expect(keyedRow.environment).toBe('PRODUCTION');
    expect(keyedRow.provider).toBe('vercel');
    expect(keyedRow.status).toBe('PENDING');
    expect(keyedRow.metadata.adapter).toBe('none-configured');
    expect(typeof keyedRow.metadata.executionNote).toBe('string');
    expect(keyedRow.metadata.executionNote.length).toBeGreaterThan(0);
    expect(keyedRow.metadata.notes).toBe('ship it');
    expect(keyedRow.metadata.readiness.verdict).toBe('NEEDS_REVIEW');
    expect(keyedRow.metadata.fileCount).toBe(1);

    const jwt = await api(
      'POST',
      '/applications/' + mainAppId + '/deployments',
      { environment: 'STAGING' },
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(201);
    const jwtRow = jwt.body as unknown as { id: string; provider: string | null; status: string };
    expect(jwtRow.provider).toBe(null);
    expect(jwtRow.status).toBe('PENDING');

    const keyedListing = await api('GET', '/genapi/applications/' + mainAppId + '/deployments', undefined, deployKey.key);
    expect(keyedListing.status).toBe(200);
    const keyedRows = keyedListing.body as unknown as Array<{ id: string; createdAt: string }>;
    expect(keyedRows.length).toBe(2);
    expect(keyedRows.map((row) => row.id).sort()).toEqual([jwtRow.id, keyedRow.id].sort());

    const jwtListing = await api('GET', '/applications/' + mainAppId + '/deployments', undefined, hank.tokens.accessToken);
    expect(jwtListing.status).toBe(200);
    expect(jwtListing.body).toEqual(keyedListing.body);

    const listings = [
      keyedRows,
      jwtListing.body as unknown as Array<{ createdAt: string }>,
    ];
    for (const rows of listings) {
      for (let idx = 1; idx < rows.length; idx += 1) {
        expect(rows[idx - 1].createdAt >= rows[idx].createdAt).toBe(true);
      }
    }

    expect(await auditCount(organizationId)).toBe(before + 1);
  });

  it('attributes the keyed create to the acting key and the JWT create to the user', async () => {
    const before = await auditCount(organizationId);

    const keyed = await api(
      'POST',
      '/genapi/applications/' + mainAppId + '/deployments',
      { environment: 'PREVIEW' },
      deployKey.key,
    );
    expect(keyed.status).toBe(201);
    const keyedDeployment = keyed.body as unknown as { id: string };

    const jwt = await api(
      'POST',
      '/applications/' + mainAppId + '/deployments',
      { environment: 'PREVIEW' },
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(201);
    const jwtDeployment = jwt.body as unknown as { id: string };

    const keyedAudit = await prisma.auditEvent.findFirst({
      where: { organizationId, action: 'application.deployment.record', resourceId: keyedDeployment.id },
    });
    expect(keyedAudit).not.toBeNull();
    expect(keyedAudit!.actorUserId).toBe(hank.userId);
    const keyedMetadata = keyedAudit!.metadata as Record<string, unknown>;
    expect(keyedMetadata.via).toBe('genapi');
    expect(keyedMetadata.apiKeyId).toBe(deployKey.id);
    expect(keyedMetadata.environment).toBe('PREVIEW');

    const jwtAudit = await prisma.auditEvent.findFirst({
      where: { action: 'application.deployment.record', resourceId: jwtDeployment.id },
    });
    expect(jwtAudit).not.toBeNull();
    expect(jwtAudit!.organizationId).toBe(null);
    expect(jwtAudit!.actorUserId).toBe(hank.userId);
    const jwtMetadata = jwtAudit!.metadata as Record<string, unknown>;
    expect(jwtMetadata.via).toBeUndefined();

    expect(await prisma.auditEvent.count({ where: { resourceId: keyedDeployment.id } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { resourceId: jwtDeployment.id } })).toBe(1);
    expect(await auditCount(organizationId)).toBe(before + 1);
  });

  it('refuses readiness failures with the honest blocked report on both surfaces', async () => {
    const before = await auditCount(organizationId);
    const beforeRows = await prisma.deployment.count({ where: { applicationId: blockedAppId } });

    const keyed = await api(
      'POST',
      '/genapi/applications/' + blockedAppId + '/deployments',
      { environment: 'PRODUCTION' },
      deployKey.key,
    );
    expect(keyed.status).toBe(400);
    expect((keyed.body as { message: string }).message).toBe('Deployment blocked by readiness checks. Fix the failing checks before recording a deployment.');
    expect(((keyed.body as { readiness: { verdict: string } }).readiness).verdict).toBe('BLOCKED');

    const jwt = await api(
      'POST',
      '/applications/' + blockedAppId + '/deployments',
      { environment: 'PRODUCTION' },
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(400);
    expect((jwt.body as { message: string }).message).toBe('Deployment blocked by readiness checks. Fix the failing checks before recording a deployment.');
    expect(((jwt.body as { readiness: { verdict: string } }).readiness).verdict).toBe('BLOCKED');

    expect(await prisma.deployment.count({ where: { applicationId: blockedAppId } })).toBe(beforeRows);
    expect(await auditCount(organizationId)).toBe(before);
  });

  it('tenant-bounds the keyed create behind one uniform 404', async () => {
    const beforeHank = await auditCount(organizationId);
    const beforeIris = await auditCount(foreignOrganizationId);

    const foreign = await api(
      'POST',
      '/genapi/applications/' + mainAppId + '/deployments',
      { environment: 'PRODUCTION' },
      irisWriterKey.key,
    );
    expect(foreign.status).toBe(404);
    expect((foreign.body as { message: string }).message).toBe('Application not found.');

    const own = await api(
      'POST',
      '/genapi/applications/' + irisAppId + '/deployments',
      { environment: 'PRODUCTION' },
      deployKey.key,
    );
    expect(own.status).toBe(404);
    expect((own.body as { message: string }).message).toBe('Application not found.');

    const unknown = await api(
      'POST',
      '/genapi/applications/unknown-' + runId + '/deployments',
      { environment: 'PRODUCTION' },
      deployKey.key,
    );
    expect(unknown.status).toBe(404);
    expect((unknown.body as { message: string }).message).toBe('Application not found.');

    expect(await auditCount(organizationId)).toBe(beforeHank);
    expect(await auditCount(foreignOrganizationId)).toBe(beforeIris);
  });

  it('keeps archived application reads and refuses archived application creates', async () => {
    const before = await auditCount(organizationId);

    const archive = await api('POST', '/genapi/applications/' + archivedAppId + '/archive', {}, deployKey.key);
    expect([200, 201]).toContain(archive.status);
    expect(await auditCount(organizationId)).toBe(before + 1);

    const created = await api(
      'POST',
      '/genapi/applications/' + archivedAppId + '/deployments',
      { environment: 'PRODUCTION' },
      deployKey.key,
    );
    expect(created.status).toBe(404);
    expect((created.body as { message: string }).message).toBe('Application not found.');

    const readiness = await api('GET', '/genapi/applications/' + archivedAppId + '/deployments/readiness', undefined, deployKey.key);
    expect(readiness.status).toBe(200);
    expect((readiness.body as { verdict: string }).verdict).toBe('NEEDS_REVIEW');

    const listing = await api('GET', '/genapi/applications/' + archivedAppId + '/deployments', undefined, deployKey.key);
    expect(listing.status).toBe(200);
    expect(Array.isArray(listing.body)).toBe(true);

    expect(await auditCount(organizationId)).toBe(before + 1);
  });

  it('double-tapped keyed creates land exactly two deployments and two audit rows', async () => {
    const beforeRows = await prisma.deployment.count({ where: { applicationId: mainAppId } });
    const beforeAudit = await prisma.auditEvent.count({
      where: { organizationId, action: 'application.deployment.record' },
    });

    const raced = await Promise.all([
      api('POST', '/genapi/applications/' + mainAppId + '/deployments', { environment: 'STAGING' }, deployKey.key),
      api('POST', '/genapi/applications/' + mainAppId + '/deployments', { environment: 'STAGING' }, deployKey.key),
    ]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(201);
    const firstDeployment = raced[0].body as unknown as { id: string };
    const secondDeployment = raced[1].body as unknown as { id: string };
    expect(firstDeployment.id).not.toBe(secondDeployment.id);

    expect(await prisma.deployment.count({ where: { applicationId: mainAppId } })).toBe(beforeRows + 2);
    expect(await prisma.auditEvent.count({
      where: { organizationId, action: 'application.deployment.record' },
    })).toBe(beforeAudit + 2);

    const auditRows = await prisma.auditEvent.findMany({
      where: {
        organizationId,
        action: 'application.deployment.record',
        resourceId: { in: [firstDeployment.id, secondDeployment.id] },
      },
      select: { resourceId: true, metadata: true },
    });
    expect(auditRows.length).toBe(2);
    expect(auditRows.map((row) => row.resourceId).sort()).toEqual([firstDeployment.id, secondDeployment.id].sort());
    for (const row of auditRows) {
      expect((row.metadata as Record<string, unknown>).via).toBe('genapi');
    }
  });

  it('races a keyed create against a JWT create cleanly', async () => {
    const beforeRows = await prisma.deployment.count({ where: { applicationId: mainAppId } });

    const raced = await Promise.all([
      api('POST', '/genapi/applications/' + mainAppId + '/deployments', { environment: 'PRODUCTION' }, deployKey.key),
      api('POST', '/applications/' + mainAppId + '/deployments', { environment: 'PRODUCTION' }, hank.tokens.accessToken),
    ]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(201);
    const keyedDeployment = raced[0].body as unknown as { id: string };
    const jwtDeployment = raced[1].body as unknown as { id: string };

    expect(await prisma.deployment.count({ where: { applicationId: mainAppId } })).toBe(beforeRows + 2);

    const keyedListing = await api('GET', '/genapi/applications/' + mainAppId + '/deployments', undefined, deployKey.key);
    expect(keyedListing.status).toBe(200);
    const jwtListing = await api('GET', '/applications/' + mainAppId + '/deployments', undefined, hank.tokens.accessToken);
    expect(jwtListing.status).toBe(200);
    expect(jwtListing.body).toEqual(keyedListing.body);

    const ids = (keyedListing.body as unknown as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toContain(keyedDeployment.id);
    expect(ids).toContain(jwtDeployment.id);
  });

  it('refuses wrong scopes and invalid bodies with zero side effects', async () => {
    const beforeRows = await prisma.deployment.count({ where: { applicationId: mainAppId } });
    const before = await auditCount(organizationId);

    const refused = await api(
      'POST',
      '/genapi/applications/' + mainAppId + '/deployments',
      { environment: 'PRODUCTION' },
      readerKey.key,
    );
    expect(refused.status).toBe(403);
    expect((refused.body as { message: string }).message).toBe('The API key does not grant the required scope.');

    const badEnvironment = await api(
      'POST',
      '/genapi/applications/' + mainAppId + '/deployments',
      { environment: 'prod' },
      deployKey.key,
    );
    expect(badEnvironment.status).toBe(400);

    const longNotes = await api(
      'POST',
      '/genapi/applications/' + mainAppId + '/deployments',
      { environment: 'PRODUCTION', notes: 'x'.repeat(501) },
      deployKey.key,
    );
    expect(longNotes.status).toBe(400);

    const rogueField = await api(
      'POST',
      '/genapi/applications/' + mainAppId + '/deployments',
      { environment: 'PRODUCTION', rogue: 'x' },
      deployKey.key,
    );
    expect(rogueField.status).toBe(400);

    expect(await prisma.deployment.count({ where: { applicationId: mainAppId } })).toBe(beforeRows);
    expect(await auditCount(organizationId)).toBe(before);
  });

  it('mirrors the readiness report exactly between the keyed and JWT surfaces', async () => {
    const before = await auditCount(organizationId);

    const keyed = await api('GET', '/genapi/applications/' + mainAppId + '/deployments/readiness', undefined, deployKey.key);
    expect(keyed.status).toBe(200);
    const jwt = await api('GET', '/applications/' + mainAppId + '/deployments/readiness', undefined, hank.tokens.accessToken);
    expect(jwt.status).toBe(200);
    expect(keyed.body).toEqual(jwt.body);
    expect((keyed.body as { verdict: string }).verdict).toBe('NEEDS_REVIEW');

    expect(await auditCount(organizationId)).toBe(before);
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect([200, 201]).toContain(revoke.status);

    const revokedCall = await api(
      'POST',
      '/genapi/applications/' + mainAppId + '/deployments',
      { environment: 'PRODUCTION' },
      revokedKey.key,
    );
    expect(revokedCall.status).toBe(401);
    expect((revokedCall.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredCall = await api(
      'POST',
      '/genapi/applications/' + mainAppId + '/deployments',
      { environment: 'PRODUCTION' },
      shortLivedKey.key,
    );
    expect(expiredCall.status).toBe(401);
    expect((expiredCall.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const anonymous = await api(
      'POST',
      '/genapi/applications/' + mainAppId + '/deployments',
      { environment: 'PRODUCTION' },
    );
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { message: string }).message).toBe('A valid GENESIS API key is required.');
  });
});
