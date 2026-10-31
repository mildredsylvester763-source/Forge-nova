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
 * Key-authenticated hierarchy reads against the real app and the real
 * CI PostgreSQL. Grounded in the GitHub REST surface: listing and
 * inspecting organization projects needs only the Projects read
 * permission, and listing the grouping structures of an organization
 * needs only the organization-level read permission (the classic
 * read:org scope for team listings). The key surface mirrors the JWT
 * surface exactly so the two can never drift apart: the workspaces
 * listing, the workspace project listing, and the project inspection
 * share their row shapes with the JWT routes, and because the JWT
 * surface has no single-application read, the key surface deliberately
 * gets none either. Foreign and unknown resources answer one uniform
 * 404 that never leaks what exists in other tenants, reads stay
 * possible on archived projects exactly like the JWT read law, and
 * reads never write audit rows.
 */
suite('GENESIS genapi hierarchy flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId: string;
  let foreignOrganizationId: string;
  let workspaceAId: string;
  let foreignWorkspaceId: string;
  let projectAId: string;
  let foreignProjectId: string;
  let orgKey: KeyContext;
  let projKey: KeyContext;
  let appKey: KeyContext;
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
    const email = 'genesis-hier-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'hierarchy-password-123',
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

  it('seeds two organizations, workspaces, projects, and scoped keys', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankWorkspaces = await api('GET', '/workspaces', undefined, hank.tokens.accessToken);
    expect(hankWorkspaces.status).toBe(200);
    const hankRows = hankWorkspaces.body as unknown as Array<{ id: string }>;
    expect(hankRows.length).toBeGreaterThan(0);
    workspaceAId = hankRows[0].id;

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;
    expect(foreignOrganizationId).not.toBe(organizationId);

    const irisWorkspaces = await api('GET', '/workspaces', undefined, iris.tokens.accessToken);
    expect(irisWorkspaces.status).toBe(200);
    foreignWorkspaceId = (irisWorkspaces.body as unknown as Array<{ id: string }>)[0].id;
    expect(foreignWorkspaceId).not.toBe(workspaceAId);

    const projectA = await api(
      'POST',
      '/workspaces/' + workspaceAId + '/projects',
      { name: 'Hierarchy Project ' + runId },
      hank.tokens.accessToken,
    );
    expect(projectA.status).toBe(201);
    projectAId = (projectA.body as { id: string }).id;

    const foreignProject = await api(
      'POST',
      '/workspaces/' + foreignWorkspaceId + '/projects',
      { name: 'Foreign Hierarchy Project ' + runId },
      iris.tokens.accessToken,
    );
    expect(foreignProject.status).toBe(201);
    foreignProjectId = (foreignProject.body as { id: string }).id;

    const application = await api(
      'POST',
      '/projects/' + projectAId + '/applications',
      { name: 'Hierarchy App ' + runId },
      hank.tokens.accessToken,
    );
    expect(application.status).toBe(201);

    orgKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Hierarchy Org Reader',
      ['READ_ORGANIZATION'],
    );
    projKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Hierarchy Project Reader',
      ['READ_PROJECTS'],
    );
    appKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Hierarchy App Reader',
      ['READ_APPLICATIONS'],
    );
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Hierarchy Short Lived',
      ['READ_PROJECTS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Hierarchy Revoked',
      ['READ_PROJECTS'],
    );
    irisKey = await createKey(
      iris.tokens.accessToken,
      foreignOrganizationId,
      'Foreign Hierarchy Reader',
      ['READ_ORGANIZATION', 'READ_PROJECTS'],
    );
  });

  it('mirrors the JWT workspace listing exactly', async () => {
    const keyed = await api('GET', '/genapi/workspaces', undefined, orgKey.key);
    expect(keyed.status).toBe(200);
    const jwt = await api('GET', '/workspaces', undefined, hank.tokens.accessToken);
    expect(jwt.status).toBe(200);
    expect(keyed.body).toEqual(jwt.body);
    const rows = keyed.body as unknown as Array<{ id: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('mirrors the JWT workspace project listing exactly', async () => {
    const keyed = await api(
      'GET',
      '/genapi/workspaces/' + workspaceAId + '/projects',
      undefined,
      projKey.key,
    );
    expect(keyed.status).toBe(200);
    const jwt = await api(
      'GET',
      '/workspaces/' + workspaceAId + '/projects',
      undefined,
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(200);
    expect(keyed.body).toEqual(jwt.body);
    const rows = keyed.body as unknown as Array<{ id: string }>;
    expect(rows.some((row) => row.id === projectAId)).toBe(true);
  });

  it('mirrors the JWT project inspection exactly', async () => {
    const keyed = await api('GET', '/genapi/projects/' + projectAId, undefined, projKey.key);
    expect(keyed.status).toBe(200);
    const jwt = await api('GET', '/projects/' + projectAId, undefined, hank.tokens.accessToken);
    expect(jwt.status).toBe(200);
    expect(keyed.body).toEqual(jwt.body);
    const body = keyed.body as { applications: Array<{ id: string }> };
    expect(body.applications.length).toBeGreaterThan(0);
  });

  it('tenant-bounds keys away from foreign workspaces and projects', async () => {
    const foreignWorkspaces = await api('GET', '/genapi/workspaces', undefined, irisKey.key);
    expect(foreignWorkspaces.status).toBe(200);
    const foreignIds = new Set(
      (foreignWorkspaces.body as unknown as Array<{ id: string }>).map((row) => row.id),
    );
    expect(foreignIds.has(workspaceAId)).toBe(false);
    expect(foreignIds.has(foreignWorkspaceId)).toBe(true);

    const workspaceMessages = new Set<string>();
    const foreignWorkspaceProjects = await api(
      'GET',
      '/genapi/workspaces/' + workspaceAId + '/projects',
      undefined,
      irisKey.key,
    );
    expect(foreignWorkspaceProjects.status).toBe(404);
    workspaceMessages.add((foreignWorkspaceProjects.body as { message: string }).message);
    const unknownWorkspace = await api(
      'GET',
      '/genapi/workspaces/does-not-exist-at-all/projects',
      undefined,
      projKey.key,
    );
    expect(unknownWorkspace.status).toBe(404);
    workspaceMessages.add((unknownWorkspace.body as { message: string }).message);
    expect(workspaceMessages.size).toBe(1);
    expect(Array.from(workspaceMessages)[0]).toBe('Workspace not found.');

    const projectMessages = new Set<string>();
    const foreignProjectInspect = await api(
      'GET',
      '/genapi/projects/' + projectAId,
      undefined,
      irisKey.key,
    );
    expect(foreignProjectInspect.status).toBe(404);
    projectMessages.add((foreignProjectInspect.body as { message: string }).message);
    const foreignFromHank = await api(
      'GET',
      '/genapi/projects/' + foreignProjectId,
      undefined,
      projKey.key,
    );
    expect(foreignFromHank.status).toBe(404);
    projectMessages.add((foreignFromHank.body as { message: string }).message);
    const unknownProject = await api(
      'GET',
      '/genapi/projects/does-not-exist-at-all',
      undefined,
      projKey.key,
    );
    expect(unknownProject.status).toBe(404);
    projectMessages.add((unknownProject.body as { message: string }).message);
    expect(projectMessages.size).toBe(1);
    expect(Array.from(projectMessages)[0]).toBe('Project not found.');
  });

  it('refuses keys without the matching scope with one message', async () => {
    const messages = new Set<string>();
    for (const path of [
      '/genapi/workspaces',
      '/genapi/workspaces/' + workspaceAId + '/projects',
      '/genapi/projects/' + projectAId,
    ]) {
      const refused = await api('GET', path, undefined, appKey.key);
      expect(refused.status).toBe(403);
      messages.add((refused.body as { message: string }).message);
    }
    for (const path of [
      '/genapi/workspaces/' + workspaceAId + '/projects',
      '/genapi/projects/' + projectAId,
    ]) {
      const refused = await api('GET', path, undefined, orgKey.key);
      expect(refused.status).toBe(403);
      messages.add((refused.body as { message: string }).message);
    }
    const refusedWorkspaces = await api('GET', '/genapi/workspaces', undefined, projKey.key);
    expect(refusedWorkspaces.status).toBe(403);
    messages.add((refusedWorkspaces.body as { message: string }).message);
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('The API key does not grant the required scope.');
  });

  it('never writes audit rows for reads or refusals', async () => {
    const before = await auditCount();

    const read = await api('GET', '/genapi/workspaces', undefined, orgKey.key);
    expect(read.status).toBe(200);
    const list = await api(
      'GET',
      '/genapi/workspaces/' + workspaceAId + '/projects',
      undefined,
      projKey.key,
    );
    expect(list.status).toBe(200);
    const inspect = await api('GET', '/genapi/projects/' + projectAId, undefined, projKey.key);
    expect(inspect.status).toBe(200);
    const refused = await api('GET', '/genapi/projects/' + projectAId, undefined, appKey.key);
    expect(refused.status).toBe(403);
    const unknown = await api(
      'GET',
      '/genapi/projects/does-not-exist-at-all',
      undefined,
      projKey.key,
    );
    expect(unknown.status).toBe(404);
    const unauthenticated = await api('GET', '/genapi/workspaces');
    expect(unauthenticated.status).toBe(401);

    expect(await auditCount()).toBe(before);
  });

  it('answers a double-tapped project inspection with identical clean bodies', async () => {
    const raced = await Promise.all([
      api('GET', '/genapi/projects/' + projectAId, undefined, projKey.key),
      api('GET', '/genapi/projects/' + projectAId, undefined, projKey.key),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([200, 200]);
    expect(raced[0].body).toEqual(raced[1].body);
  });

  it('stays clean when a keyed inspection races a JWT project archive', async () => {
    const raced = await Promise.all([
      api('GET', '/genapi/projects/' + projectAId, undefined, projKey.key),
      api('POST', '/projects/' + projectAId + '/archive', {}, hank.tokens.accessToken),
    ]);
    expect(raced[0].status).toBe(200);
    const inspectedStatus = (raced[0].body as { status: string }).status;
    expect(['ACTIVE', 'ARCHIVED']).toContain(inspectedStatus);
    expect(raced[1].status).toBe(201);
    const archived = await prisma.project.findUnique({
      where: { id: projectAId },
      select: { status: true },
    });
    expect(archived?.status).toBe('ARCHIVED');

    // Reads stay possible on archived projects, mirroring the JWT law
    // that archive blocks writes, not reads.
    const after = await api('GET', '/genapi/projects/' + projectAId, undefined, projKey.key);
    expect(after.status).toBe(200);
    expect((after.body as { status: string }).status).toBe('ARCHIVED');
  });

  it('shows a JWT-created project to a later keyed listing after a race', async () => {
    const raced = await Promise.all([
      api('GET', '/genapi/workspaces/' + workspaceAId + '/projects', undefined, projKey.key),
      api(
        'POST',
        '/workspaces/' + workspaceAId + '/projects',
        { name: 'Hierarchy Raced Project ' + runId },
        hank.tokens.accessToken,
      ),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(201);
    const racedProjectId = (raced[1].body as { id: string }).id;
    const listed = raced[0].body as unknown as Array<{ id: string }>;
    expect(listed.length).toBeGreaterThanOrEqual(1);

    const after = await api(
      'GET',
      '/genapi/workspaces/' + workspaceAId + '/projects',
      undefined,
      projKey.key,
    );
    expect(after.status).toBe(200);
    const rows = after.body as unknown as Array<{ id: string }>;
    expect(rows.some((row) => row.id === racedProjectId)).toBe(true);
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
      '/genapi/projects/' + projectAId,
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
      '/genapi/projects/' + projectAId,
      undefined,
      shortLivedKey.key,
    );
    expect(expiredRead.status).toBe(401);
    expect((expiredRead.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    const unauthenticated = await api('GET', '/genapi/workspaces');
    expect(unauthenticated.status).toBe(401);
    expect((unauthenticated.body as { message: string }).message).toBe(
      'A valid GENESIS API key is required.',
    );
  });
});
