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
 * Key-authenticated per-project application listing against the real
 * app and the real CI PostgreSQL. Grounded in the market leaders: the
 * GitHub list-organization-repositories surface lists child resources
 * with nothing more than the base read permission, and the OpenAI
 * list-projects surface returns the children of one organization as a
 * flat array straight from an API key. READ_APPLICATIONS governs the
 * keyed listing because the rows are application rows. The listing
 * mirrors the JWT per-project listing exactly through the shared core
 * (newest activity first, archived applications hidden), the readable
 * tenant bound refuses foreign, missing, and deleted projects with one
 * uniform 404, reads stay possible on archived projects exactly like
 * the JWT read law, and reads never write audit rows.
 */
suite('GENESIS genapi project application flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId: string;
  let foreignOrganizationId: string;
  let workspaceAId: string;
  let projectAId: string;
  let foreignProjectId: string;
  let alphaId: string;
  let betaId: string;
  let gammaId: string;
  let appKey: KeyContext;
  let projKey: KeyContext;
  let orgKey: KeyContext;
  let writerKey: KeyContext;
  let shortLivedKey: KeyContext;
  let revokedKey: KeyContext;
  let irisKey: KeyContext;
  const createdUserIds: string[] = [];
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
    const email = 'genesis-pra-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'project-apps-password-123',
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

  const createApplication = async (token: string, name: string): Promise<string> => {
    const response = await api(
      'POST',
      '/projects/' + projectAId + '/applications',
      { name },
      token,
    );
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  };

  const keyedListing = () =>
    api('GET', '/genapi/projects/' + projectAId + '/applications', undefined, appKey.key);
  const jwtListing = () =>
    api('GET', '/projects/' + projectAId + '/applications', undefined, hank.tokens.accessToken);

  const auditCount = () => prisma.auditEvent.count({ where: { organizationId } });

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

  it('seeds two organizations, projects, applications, and scoped keys', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;
    expect(foreignOrganizationId).not.toBe(organizationId);

    const hankWorkspaces = await api('GET', '/workspaces', undefined, hank.tokens.accessToken);
    expect(hankWorkspaces.status).toBe(200);
    workspaceAId = (hankWorkspaces.body as unknown as Array<{ id: string }>)[0].id;

    const irisWorkspaces = await api('GET', '/workspaces', undefined, iris.tokens.accessToken);
    expect(irisWorkspaces.status).toBe(200);
    const foreignWorkspaceId = (irisWorkspaces.body as unknown as Array<{ id: string }>)[0].id;

    const projectA = await api(
      'POST',
      '/workspaces/' + workspaceAId + '/projects',
      { name: 'Project Apps Project ' + runId },
      hank.tokens.accessToken,
    );
    expect(projectA.status).toBe(201);
    projectAId = (projectA.body as { id: string }).id;

    const foreignProject = await api(
      'POST',
      '/workspaces/' + foreignWorkspaceId + '/projects',
      { name: 'Foreign Project Apps ' + runId },
      iris.tokens.accessToken,
    );
    expect(foreignProject.status).toBe(201);
    foreignProjectId = (foreignProject.body as { id: string }).id;

    const foreignApp = await api(
      'POST',
      '/projects/' + foreignProjectId + '/applications',
      { name: 'Foreign Project App ' + runId },
      iris.tokens.accessToken,
    );
    expect(foreignApp.status).toBe(201);

    alphaId = await createApplication(hank.tokens.accessToken, 'Project Apps Alpha ' + runId);
    betaId = await createApplication(hank.tokens.accessToken, 'Project Apps Beta ' + runId);
    gammaId = await createApplication(hank.tokens.accessToken, 'Project Apps Gamma ' + runId);

    appKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Project Apps Reader',
      ['READ_APPLICATIONS'],
    );
    projKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Project Apps Project Reader',
      ['READ_PROJECTS'],
    );
    orgKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Project Apps Org Reader',
      ['READ_ORGANIZATION'],
    );
    writerKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Project Apps Writer',
      ['READ_APPLICATIONS', 'WRITE_APPLICATIONS'],
    );
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Project Apps Short Lived',
      ['READ_APPLICATIONS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Project Apps Revoked',
      ['READ_APPLICATIONS'],
    );
    irisKey = await createKey(
      iris.tokens.accessToken,
      foreignOrganizationId,
      'Foreign Project Apps Reader',
      ['READ_APPLICATIONS'],
    );
  });

  it('mirrors the JWT per-project application listing exactly', async () => {
    const keyed = await keyedListing();
    expect(keyed.status).toBe(200);
    const jwt = await jwtListing();
    expect(jwt.status).toBe(200);
    expect(keyed.body).toEqual(jwt.body);
    const rows = keyed.body as unknown as Array<{ id: string; projectId: string }>;
    expect(rows.length).toBe(3);
    expect(rows.every((row) => row.projectId === projectAId)).toBe(true);
    const ids = new Set(rows.map((row) => row.id));
    expect(ids.has(alphaId)).toBe(true);
    expect(ids.has(betaId)).toBe(true);
    expect(ids.has(gammaId)).toBe(true);
  });

  it('orders by newest activity and matches database truth', async () => {
    const refreshed = await api(
      'PATCH',
      '/projects/' + projectAId + '/applications/' + alphaId,
      { description: 'Refreshed by the ordering test ' + runId },
      hank.tokens.accessToken,
    );
    expect(refreshed.status).toBe(200);

    const keyed = await keyedListing();
    expect(keyed.status).toBe(200);
    const rows = keyed.body as unknown as Array<{ id: string }>;
    expect(rows[0].id).toBe(alphaId);

    const jwt = await jwtListing();
    expect(jwt.status).toBe(200);
    expect(keyed.body).toEqual(jwt.body);

    const truth = await prisma.application.findMany({
      where: { projectId: projectAId, status: { not: 'ARCHIVED' } },
      select: { id: true },
      orderBy: { updatedAt: 'desc' },
    });
    expect(truth[0].id).toBe(alphaId);
    expect(new Set(truth.map((row) => row.id))).toEqual(new Set(rows.map((row) => row.id)));
  });

  it('hides archived applications from both surfaces', async () => {
    const archive = await api(
      'POST',
      '/projects/' + projectAId + '/applications/' + gammaId + '/archive',
      {},
      hank.tokens.accessToken,
    );
    expect(archive.status).toBe(201);

    const keyed = await keyedListing();
    expect(keyed.status).toBe(200);
    const jwt = await jwtListing();
    expect(jwt.status).toBe(200);
    expect(keyed.body).toEqual(jwt.body);
    const rows = keyed.body as unknown as Array<{ id: string }>;
    expect(rows.length).toBe(2);
    expect(rows.some((row) => row.id === gammaId)).toBe(false);
    expect(rows.some((row) => row.id === alphaId)).toBe(true);
    expect(rows.some((row) => row.id === betaId)).toBe(true);
  });

  it('refuses keys without the matching scope with one message', async () => {
    const messages = new Set<string>();
    const refusedProject = await api(
      'GET',
      '/genapi/projects/' + projectAId + '/applications',
      undefined,
      projKey.key,
    );
    expect(refusedProject.status).toBe(403);
    messages.add((refusedProject.body as { message: string }).message);
    const refusedOrg = await api(
      'GET',
      '/genapi/projects/' + projectAId + '/applications',
      undefined,
      orgKey.key,
    );
    expect(refusedOrg.status).toBe(403);
    messages.add((refusedOrg.body as { message: string }).message);
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('The API key does not grant the required scope.');
  });

  it('tenant-bounds keys to the projects of their own organization', async () => {
    const messages = new Set<string>();
    const foreignOnOwn = await api(
      'GET',
      '/genapi/projects/' + projectAId + '/applications',
      undefined,
      irisKey.key,
    );
    expect(foreignOnOwn.status).toBe(404);
    messages.add((foreignOnOwn.body as { message: string }).message);
    const ownOnForeign = await api(
      'GET',
      '/genapi/projects/' + foreignProjectId + '/applications',
      undefined,
      appKey.key,
    );
    expect(ownOnForeign.status).toBe(404);
    messages.add((ownOnForeign.body as { message: string }).message);
    const unknown = await api(
      'GET',
      '/genapi/projects/does-not-exist-at-all/applications',
      undefined,
      appKey.key,
    );
    expect(unknown.status).toBe(404);
    messages.add((unknown.body as { message: string }).message);
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Project not found.');

    const own = await keyedListing();
    expect(own.status).toBe(200);
    const ownIds = new Set(
      (own.body as unknown as Array<{ id: string }>).map((row) => row.id),
    );
    const foreign = await api(
      'GET',
      '/genapi/projects/' + foreignProjectId + '/applications',
      undefined,
      irisKey.key,
    );
    expect(foreign.status).toBe(200);
    const foreignIds = new Set(
      (foreign.body as unknown as Array<{ id: string }>).map((row) => row.id),
    );
    expect(foreignIds.size).toBeGreaterThan(0);
    for (const id of ownIds) {
      expect(foreignIds.has(id)).toBe(false);
    }
  });

  it('never writes audit rows for reads or refusals', async () => {
    const before = await auditCount();

    const read = await keyedListing();
    expect(read.status).toBe(200);
    const refused = await api(
      'GET',
      '/genapi/projects/' + projectAId + '/applications',
      undefined,
      projKey.key,
    );
    expect(refused.status).toBe(403);
    const unknown = await api(
      'GET',
      '/genapi/projects/does-not-exist-at-all/applications',
      undefined,
      appKey.key,
    );
    expect(unknown.status).toBe(404);
    const unauthenticated = await api(
      'GET',
      '/genapi/projects/' + projectAId + '/applications',
    );
    expect(unauthenticated.status).toBe(401);

    expect(await auditCount()).toBe(before);
  });

  it('answers a double-tapped listing with identical clean bodies', async () => {
    const raced = await Promise.all([keyedListing(), keyedListing()]);
    expect(raced.map((response) => response.status).sort()).toEqual([200, 200]);
    expect(raced[0].body).toEqual(raced[1].body);
  });

  it('stays clean when a keyed listing races a JWT application create', async () => {
    const raced = await Promise.all([
      keyedListing(),
      api(
        'POST',
        '/projects/' + projectAId + '/applications',
        { name: 'Project Apps Delta ' + runId },
        hank.tokens.accessToken,
      ),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(201);
    const deltaId = (raced[1].body as { id: string }).id;

    const after = await keyedListing();
    expect(after.status).toBe(200);
    const rows = after.body as unknown as Array<{ id: string }>;
    expect(rows.some((row) => row.id === deltaId)).toBe(true);

    const jwtAfter = await jwtListing();
    expect(jwtAfter.status).toBe(200);
    expect(after.body).toEqual(jwtAfter.body);
  });

  it('stays clean when a keyed listing races a keyed application archive', async () => {
    const raced = await Promise.all([
      keyedListing(),
      api('POST', '/genapi/applications/' + betaId + '/archive', {}, writerKey.key),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(201);

    const stored = await prisma.application.findUnique({
      where: { id: betaId },
      select: { status: true },
    });
    expect(stored?.status).toBe('ARCHIVED');

    const after = await keyedListing();
    expect(after.status).toBe(200);
    const rows = after.body as unknown as Array<{ id: string }>;
    expect(rows.some((row) => row.id === betaId)).toBe(false);

    const jwtAfter = await jwtListing();
    expect(jwtAfter.status).toBe(200);
    expect(after.body).toEqual(jwtAfter.body);
  });

  it('keeps reads possible on an archived project exactly like the JWT law', async () => {
    const archive = await api(
      'POST',
      '/projects/' + projectAId + '/archive',
      {},
      hank.tokens.accessToken,
    );
    expect(archive.status).toBe(201);

    const keyed = await keyedListing();
    expect(keyed.status).toBe(200);
    const rows = keyed.body as unknown as Array<{ id: string }>;
    expect(rows.length).toBe(2);
    expect(rows.some((row) => row.id === alphaId)).toBe(true);

    const jwt = await jwtListing();
    expect(jwt.status).toBe(200);
    expect(keyed.body).toEqual(jwt.body);
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect([200, 201]).toContain(revoke.status);

    const revokedRead = await api(
      'GET',
      '/genapi/projects/' + projectAId + '/applications',
      undefined,
      revokedKey.key,
    );
    expect(revokedRead.status).toBe(401);
    expect((revokedRead.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredRead = await api(
      'GET',
      '/genapi/projects/' + projectAId + '/applications',
      undefined,
      shortLivedKey.key,
    );
    expect(expiredRead.status).toBe(401);
    expect((expiredRead.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    const unauthenticated = await api(
      'GET',
      '/genapi/projects/' + projectAId + '/applications',
    );
    expect(unauthenticated.status).toBe(401);
    expect((unauthenticated.body as { message: string }).message).toBe(
      'A valid GENESIS API key is required.',
    );
  });
});
