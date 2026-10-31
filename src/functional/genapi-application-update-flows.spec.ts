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
 * Key-authenticated application updates against the real app and the
 * real CI PostgreSQL. Grounded in the market leaders: GitHub repository
 * updates (PATCH /repos) and Vercel project updates (PATCH /v9/projects)
 * are partial metadata writes by id behind write permission, never read
 * permission. The keyed update mirrors the JWT update exactly - same
 * four optional fields, same honest audit row, same application.updated
 * event - with the acting key attributed in the organization trail.
 * The writable tenant bound refuses foreign, missing, and archived
 * applications with one uniform 404, and races between the keyed and
 * JWT surfaces always end in clean, attributable outcomes, never a 500.
 */
suite('GENESIS genapi application update flows (real app, real database)', () => {
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
  let appAId: string;
  let appA2Id: string;
  let appA3Id: string;
  let foreignAppId: string;
  let writerKey: KeyContext;
  let readerKey: KeyContext;
  let shortLivedKey: KeyContext;
  let revokedKey: KeyContext;
  let irisWriterKey: KeyContext;
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
    const email = 'genesis-appu-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'update-password-123',
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

  const createApplication = async (
    token: string,
    projectId: string,
    name: string,
  ): Promise<string> => {
    const response = await api(
      'POST',
      '/projects/' + projectId + '/applications',
      { name },
      token,
    );
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  };

  const updateRows = (applicationId: string) =>
    prisma.auditEvent.count({
      where: { action: 'application.update', resourceId: applicationId },
    });

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

  it('seeds two organizations, applications, and scoped keys', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankWorkspaces = await api('GET', '/workspaces', undefined, hank.tokens.accessToken);
    expect(hankWorkspaces.status).toBe(200);
    workspaceAId = (hankWorkspaces.body as unknown as Array<{ id: string }>)[0].id;

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const projectA = await api(
      'POST',
      '/workspaces/' + workspaceAId + '/projects',
      { name: 'App Update Project ' + runId },
      hank.tokens.accessToken,
    );
    expect(projectA.status).toBe(201);
    projectAId = (projectA.body as { id: string }).id;

    // The foreign project must be created inside the foreign workspace.
    const irisWorkspaces = await api('GET', '/workspaces', undefined, iris.tokens.accessToken);
    expect(irisWorkspaces.status).toBe(200);
    const foreignWorkspaceId = (irisWorkspaces.body as unknown as Array<{ id: string }>)[0].id;
    const foreignProjectCreate = await api(
      'POST',
      '/workspaces/' + foreignWorkspaceId + '/projects',
      { name: 'Foreign App Update Project ' + runId },
      iris.tokens.accessToken,
    );
    expect(foreignProjectCreate.status).toBe(201);
    foreignProjectId = (foreignProjectCreate.body as { id: string }).id;

    appAId = await createApplication(hank.tokens.accessToken, projectAId, 'App Update Target ' + runId);
    appA2Id = await createApplication(hank.tokens.accessToken, projectAId, 'App Update Archive Target ' + runId);
    appA3Id = await createApplication(hank.tokens.accessToken, projectAId, 'App Update Race Target ' + runId);
    foreignAppId = await createApplication(iris.tokens.accessToken, foreignProjectId, 'App Update Foreign ' + runId);

    writerKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'App Update Writer',
      ['WRITE_APPLICATIONS'],
    );
    readerKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'App Update Reader',
      ['READ_APPLICATIONS'],
    );
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'App Update Short Lived',
      ['WRITE_APPLICATIONS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'App Update Revoked',
      ['WRITE_APPLICATIONS'],
    );
    irisWriterKey = await createKey(
      iris.tokens.accessToken,
      foreignOrganizationId,
      'Foreign App Update Writer',
      ['WRITE_APPLICATIONS'],
    );
  });

  it('mirrors the JWT application row exactly on a full update', async () => {
    const keyed = await api(
      'POST',
      '/genapi/applications/' + appAId + '/update',
      {
        name: 'Renamed By Key ' + runId,
        description: 'Keyed description ' + runId,
        framework: 'react',
        runtime: 'node',
      },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    const keyedBody = keyed.body as { id: string; name: string; framework: string };
    expect(keyedBody.name).toBe('Renamed By Key ' + runId);
    expect(keyedBody.framework).toBe('react');

    const jwtList = await api(
      'GET',
      '/projects/' + projectAId + '/applications',
      undefined,
      hank.tokens.accessToken,
    );
    expect(jwtList.status).toBe(200);
    const jwtRows = jwtList.body as unknown as Array<Record<string, unknown>>;
    const matching = jwtRows.find((row) => row.id === keyedBody.id);
    expect(matching).toBeDefined();
    expect(matching).toEqual(keyed.body);
  });

  it('leaves unmentioned fields untouched on a partial update', async () => {
    const before = await api(
      'GET',
      '/projects/' + projectAId + '/applications',
      undefined,
      hank.tokens.accessToken,
    );
    const beforeRow = (before.body as unknown as Array<{ id: string; name: string }>)
      .find((row) => row.id === appAId);
    expect(beforeRow).toBeDefined();

    const keyed = await api(
      'POST',
      '/genapi/applications/' + appAId + '/update',
      { framework: 'vue' },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    const keyedBody = keyed.body as { name: string; description: string; framework: string; runtime: string };
    expect(keyedBody.framework).toBe('vue');
    expect(keyedBody.name).toBe(beforeRow!.name);
    expect(keyedBody.description).toBe('Keyed description ' + runId);
    expect(keyedBody.runtime).toBe('node');
  });

  it('attributes the keyed update in the organization audit trail exactly once', async () => {
    const before = await updateRows(appAId);
    const keyed = await api(
      'POST',
      '/genapi/applications/' + appAId + '/update',
      { name: 'Attribution Check ' + runId },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    expect(await updateRows(appAId)).toBe(before + 1);

    const row = await prisma.auditEvent.findFirst({
      where: {
        action: 'application.update',
        resourceId: appAId,
        organizationId,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        actorUserId: true,
        organizationId: true,
        outcome: true,
        metadata: true,
      },
    });
    expect(row).not.toBeNull();
    expect(row?.actorUserId).toBe(hank.userId);
    expect(row?.outcome).toBe('SUCCESS');
    const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.via).toBe('genapi');
    expect(metadata.apiKeyId).toBe(writerKey.id);
    expect(metadata.apiKeyName).toBe('App Update Writer');
    expect(metadata.applicationId).toBe(appAId);
  });

  it('never writes audit rows for refused or unauthenticated updates', async () => {
    const before = await updateRows(appAId);

    const scopeRefused = await api(
      'POST',
      '/genapi/applications/' + appAId + '/update',
      { name: 'Refused Rename ' + runId },
      readerKey.key,
    );
    expect(scopeRefused.status).toBe(403);
    const tenantRefused = await api(
      'POST',
      '/genapi/applications/' + appAId + '/update',
      { name: 'Refused Rename ' + runId },
      irisWriterKey.key,
    );
    expect(tenantRefused.status).toBe(404);
    const unknown = await api(
      'POST',
      '/genapi/applications/does-not-exist-at-all/update',
      { name: 'Refused Rename ' + runId },
      writerKey.key,
    );
    expect(unknown.status).toBe(404);
    const unauthenticated = await api(
      'POST',
      '/genapi/applications/' + appAId + '/update',
      { name: 'Refused Rename ' + runId },
    );
    expect(unauthenticated.status).toBe(401);

    expect(await updateRows(appAId)).toBe(before);
  });

  it('tenant-bounds updates away from foreign and unknown applications', async () => {
    const messages = new Set<string>();

    const foreignFromIris = await api(
      'POST',
      '/genapi/applications/' + appAId + '/update',
      { name: 'Foreign Probe ' + runId },
      irisWriterKey.key,
    );
    expect(foreignFromIris.status).toBe(404);
    messages.add((foreignFromIris.body as { message: string }).message);

    const foreignFromHank = await api(
      'POST',
      '/genapi/applications/' + foreignAppId + '/update',
      { name: 'Foreign Probe ' + runId },
      writerKey.key,
    );
    expect(foreignFromHank.status).toBe(404);
    messages.add((foreignFromHank.body as { message: string }).message);

    const unknown = await api(
      'POST',
      '/genapi/applications/does-not-exist-at-all/update',
      { name: 'Unknown Probe ' + runId },
      writerKey.key,
    );
    expect(unknown.status).toBe(404);
    messages.add((unknown.body as { message: string }).message);

    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Application not found.');
  });

  it('refuses archived applications with the same uniform 404', async () => {
    const archive = await api(
      'POST',
      '/projects/' + projectAId + '/applications/' + appA2Id + '/archive',
      {},
      hank.tokens.accessToken,
    );
    expect(archive.status).toBe(201);

    const messages = new Set<string>();
    const keyedUpdate = await api(
      'POST',
      '/genapi/applications/' + appA2Id + '/update',
      { name: 'Archived Probe ' + runId },
      writerKey.key,
    );
    expect(keyedUpdate.status).toBe(404);
    messages.add((keyedUpdate.body as { message: string }).message);
    const unknown = await api(
      'POST',
      '/genapi/applications/does-not-exist-at-all/update',
      { name: 'Unknown Probe ' + runId },
      writerKey.key,
    );
    expect(unknown.status).toBe(404);
    messages.add((unknown.body as { message: string }).message);
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Application not found.');
  });

  it('refuses read-only keys with one message', async () => {
    const refused = await api(
      'POST',
      '/genapi/applications/' + appAId + '/update',
      { name: 'Scope Probe ' + runId },
      readerKey.key,
    );
    expect(refused.status).toBe(403);
    expect((refused.body as { message: string }).message).toBe(
      'The API key does not grant the required scope.',
    );
  });

  it('answers a double-tapped update with two clean attributable outcomes', async () => {
    const before = await updateRows(appAId);
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/applications/' + appAId + '/update',
        { name: 'Double Tap ' + runId },
        writerKey.key,
      ),
      api(
        'POST',
        '/genapi/applications/' + appAId + '/update',
        { name: 'Double Tap ' + runId },
        writerKey.key,
      ),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 201]);
    // Each update bumps the honest row timestamp, so the bodies match
    // on every field except updatedAt.
    const stripTimestamp = (body: Record<string, unknown>) => {
      const clone = { ...body };
      delete clone.updatedAt;
      return clone;
    };
    expect(stripTimestamp(raced[0].body)).toEqual(stripTimestamp(raced[1].body));
    expect(await updateRows(appAId)).toBe(before + 2);

    const stored = await prisma.application.findUnique({
      where: { id: appAId },
      select: { name: true },
    });
    expect(stored?.name).toBe('Double Tap ' + runId);
  });

  it('ends a keyed-versus-JWT update race cleanly with one winner', async () => {
    const before = await updateRows(appAId);
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/applications/' + appAId + '/update',
        { name: 'Key Winner ' + runId },
        writerKey.key,
      ),
      api(
        'PATCH',
        '/projects/' + projectAId + '/applications/' + appAId,
        { name: 'Jwt Winner ' + runId },
        hank.tokens.accessToken,
      ),
    ]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(200);
    expect(await updateRows(appAId)).toBe(before + 2);

    const stored = await prisma.application.findUnique({
      where: { id: appAId },
      select: { name: true },
    });
    expect(['Key Winner ' + runId, 'Jwt Winner ' + runId]).toContain(stored?.name);
  });

  it('ends an update-versus-archive race in clean outcomes only', async () => {
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/applications/' + appA3Id + '/update',
        { name: 'Archive Race ' + runId },
        writerKey.key,
      ),
      api(
        'POST',
        '/genapi/applications/' + appA3Id + '/archive',
        undefined,
        writerKey.key,
      ),
    ]);
    // The archive always lands; the update either lands before it or is
    // refused by the writable bound. Both are clean, never a 500.
    expect(raced[1].status).toBe(201);
    expect([201, 404]).toContain(raced[0].status);

    const stored = await prisma.application.findUnique({
      where: { id: appA3Id },
      select: { status: true, name: true },
    });
    expect(stored?.status).toBe('ARCHIVED');
    expect(['Archive Race ' + runId, 'App Update Race Target ' + runId]).toContain(stored?.name);
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect([200, 201]).toContain(revoke.status);

    const revokedUpdate = await api(
      'POST',
      '/genapi/applications/' + appAId + '/update',
      { name: 'Lifecycle Probe ' + runId },
      revokedKey.key,
    );
    expect(revokedUpdate.status).toBe(401);
    expect((revokedUpdate.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredUpdate = await api(
      'POST',
      '/genapi/applications/' + appAId + '/update',
      { name: 'Lifecycle Probe ' + runId },
      shortLivedKey.key,
    );
    expect(expiredUpdate.status).toBe(401);
    expect((expiredUpdate.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    const unauthenticated = await api(
      'POST',
      '/genapi/applications/' + appAId + '/update',
      { name: 'Lifecycle Probe ' + runId },
    );
    expect(unauthenticated.status).toBe(401);
    expect((unauthenticated.body as { message: string }).message).toBe(
      'A valid GENESIS API key is required.',
    );
  });
});
