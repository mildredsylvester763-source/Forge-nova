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
 * Keyed workspace rename surface over the real app and the real CI
 * PostgreSQL. Grounded in the GitHub team update REST surface: the
 * update needs the organization level write permission, sending only
 * the name changes the name while the slug stays stable, and the
 * slug is the immutable server-derived identifier that never
 * regenerates on a rename. Keys are minted only by organization
 * admins, so a WRITE_ORGANIZATION key is an admin-delegated rename,
 * the keyed rename mirrors the JWT rename exactly through the shared
 * apply core, and a workspace outside the key organization answers
 * the same uniform 404 as an unknown one. Renames never write audit
 * rows because the JWT rename writes none, and racing renames end in
 * one clean final state on one row, never a 500.
 */
suite('GENESIS keyed workspace rename flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId = '';
  let foreignOrganizationId = '';
  let writerKey: KeyContext;
  let readerKey: KeyContext;
  let projectWriterKey: KeyContext;
  let appWriterKey: KeyContext;
  let shortLivedKey: KeyContext;
  let revokedKey: KeyContext;
  let irisWriterKey: KeyContext;
  let baseWorkspaceId = '';
  let baseSlug = '';
  let irisWorkspaceId = '';
  let irisWorkspaceSlug = '';
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);
  const password = 'gwr-workspace-rename-password-123';

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
    const email = 'genesis-gwr-' + name + '-' + runId + '@example.com';
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

  const auditCount = () => prisma.auditEvent.count({ where: { organizationId } });

  const workspaceRowsInOrganization = () =>
    prisma.workspace.count({ where: { organizationId } });

  const keyedCreateWorkspace = async (
    name: string,
    key: KeyContext,
    orgId: string,
  ): Promise<{ id: string; slug: string }> => {
    const response = await api(
      'POST',
      '/genapi/workspaces',
      { name, organizationId: orgId },
      key.key,
    );
    expect(response.status).toBe(201);
    const row = response.body as { id: string; slug: string };
    return { id: row.id, slug: row.slug };
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
    const orgIds = [organizationId, foreignOrganizationId].filter((id) => id !== '');
    if (orgIds.length > 0) {
      await prisma.auditEvent.deleteMany({ where: { organizationId: { in: orgIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it('seeds two organizations and scoped keys', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;

    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'Org Writer', ['READ_ORGANIZATION', 'WRITE_ORGANIZATION']);
    readerKey = await createKey(hank.tokens.accessToken, organizationId, 'Org Reader', ['READ_ORGANIZATION']);
    projectWriterKey = await createKey(hank.tokens.accessToken, organizationId, 'Project Writer', ['READ_PROJECTS', 'WRITE_PROJECTS']);
    appWriterKey = await createKey(hank.tokens.accessToken, organizationId, 'App Writer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Short Lived',
      ['READ_ORGANIZATION', 'WRITE_ORGANIZATION'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(hank.tokens.accessToken, organizationId, 'Revoked', ['READ_ORGANIZATION', 'WRITE_ORGANIZATION']);
    irisWriterKey = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Iris Org Writer', ['READ_ORGANIZATION', 'WRITE_ORGANIZATION']);

    const base = await keyedCreateWorkspace('Base ' + runId, writerKey, organizationId);
    baseWorkspaceId = base.id;
    baseSlug = base.slug;

    const irisBase = await keyedCreateWorkspace('Iris Base ' + runId, irisWriterKey, foreignOrganizationId);
    irisWorkspaceId = irisBase.id;
    irisWorkspaceSlug = irisBase.slug;
  });

  it('mirrors the JWT rename exactly through the shared core', async () => {
    const before = await auditCount();

    const keyed = await api(
      'POST',
      '/genapi/workspaces/' + baseWorkspaceId + '/update',
      { name: '  Keyed Renamed ' + runId + '  ' },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);

    const jwtCreated = await api(
      'POST',
      '/workspaces',
      { name: 'Jwt Rename Target ' + runId, organizationId },
      hank.tokens.accessToken,
    );
    expect(jwtCreated.status).toBe(201);
    const jwtTarget = jwtCreated.body as { id: string; slug: string };

    const jwt = await api(
      'PATCH',
      '/workspaces/' + jwtTarget.id,
      { name: 'Jwt Renamed ' + runId },
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(200);

    expect(Object.keys(keyed.body).sort()).toEqual(['createdAt', 'id', 'name', 'organizationId', 'slug', 'updatedAt']);
    expect(Object.keys(keyed.body).sort()).toEqual(Object.keys(jwt.body).sort());

    const keyedRow = keyed.body as {
      id: string;
      organizationId: string;
      name: string;
      slug: string;
    };
    expect(keyedRow.id).toBe(baseWorkspaceId);
    expect(keyedRow.name).toBe('Keyed Renamed ' + runId);
    expect(keyedRow.organizationId).toBe(organizationId);
    expect(keyedRow.slug).toBe(baseSlug);

    const stored = await prisma.workspace.findUnique({
      where: { id: baseWorkspaceId },
      select: { organizationId: true, name: true, slug: true },
    });
    expect(stored).toEqual({
      organizationId,
      name: 'Keyed Renamed ' + runId,
      slug: baseSlug,
    });

    const keyedList = await api('GET', '/genapi/workspaces', undefined, readerKey.key);
    expect(keyedList.status).toBe(200);
    const keyedEntry = (keyedList.body as unknown as Array<{ id: string; name: string }>)
      .find((r) => r.id === baseWorkspaceId);
    expect(keyedEntry?.name).toBe('Keyed Renamed ' + runId);

    const jwtList = await api('GET', '/workspaces', undefined, hank.tokens.accessToken);
    expect(jwtList.status).toBe(200);
    const jwtEntry = (jwtList.body as unknown as Array<{ id: string; name: string }>)
      .find((r) => r.id === baseWorkspaceId);
    expect(jwtEntry?.name).toBe('Keyed Renamed ' + runId);

    expect(await auditCount()).toBe(before);
  });

  it('keeps the slug immutable across renames with the trim law', async () => {
    const created = await keyedCreateWorkspace('Rename Laws ' + runId, writerKey, organizationId);

    const first = await api(
      'POST',
      '/genapi/workspaces/' + created.id + '/update',
      { name: '  Payments & Data  ' },
      writerKey.key,
    );
    expect(first.status).toBe(201);
    const firstRow = first.body as { name: string; slug: string };
    expect(firstRow.name).toBe('Payments & Data');
    expect(firstRow.slug).toBe(created.slug);

    const longName = 'z'.repeat(120);
    const second = await api(
      'POST',
      '/genapi/workspaces/' + created.id + '/update',
      { name: longName },
      writerKey.key,
    );
    expect(second.status).toBe(201);
    const secondRow = second.body as { name: string; slug: string };
    expect(secondRow.name).toBe(longName);
    expect(secondRow.slug).toBe(created.slug);

    const repeat = await api(
      'POST',
      '/genapi/workspaces/' + created.id + '/update',
      { name: longName },
      writerKey.key,
    );
    expect(repeat.status).toBe(201);

    const stored = await prisma.workspace.findUnique({
      where: { id: created.id },
      select: { name: true, slug: true },
    });
    expect(stored).toEqual({ name: longName, slug: created.slug });
  });

  it('refuses rename attempts without side effects', async () => {
    const before = await auditCount();
    const nameBefore = (await prisma.workspace.findUnique({
      where: { id: baseWorkspaceId },
      select: { name: true },
    }))?.name;

    const scopeMessages = new Set<string>();
    for (const wrongKey of [readerKey, projectWriterKey, appWriterKey]) {
      const refused = await api(
        'POST',
        '/genapi/workspaces/' + baseWorkspaceId + '/update',
        { name: 'Refused ' + runId },
        wrongKey.key,
      );
      expect(refused.status).toBe(403);
      scopeMessages.add((refused.body as { message: string }).message);
    }
    expect(scopeMessages.size).toBe(1);
    expect(Array.from(scopeMessages)[0]).toBe('The API key does not grant the required scope.');

    const notFound = new Set<string>();
    const foreign = await api(
      'POST',
      '/genapi/workspaces/' + irisWorkspaceId + '/update',
      { name: 'Foreign Try ' + runId },
      writerKey.key,
    );
    expect(foreign.status).toBe(404);
    notFound.add((foreign.body as { message: string }).message);
    const unknown = await api(
      'POST',
      '/genapi/workspaces/does-not-exist-at-all/update',
      { name: 'Unknown Try ' + runId },
      writerKey.key,
    );
    expect(unknown.status).toBe(404);
    notFound.add((unknown.body as { message: string }).message);
    expect(notFound.size).toBe(1);
    expect(Array.from(notFound)[0]).toBe('Workspace not found.');

    const blank = await api(
      'POST',
      '/genapi/workspaces/' + baseWorkspaceId + '/update',
      { name: '   ' },
      writerKey.key,
    );
    expect(blank.status).toBe(400);
    const longName = await api(
      'POST',
      '/genapi/workspaces/' + baseWorkspaceId + '/update',
      { name: 'x'.repeat(121) },
      writerKey.key,
    );
    expect(longName.status).toBe(400);
    const extra = await api(
      'POST',
      '/genapi/workspaces/' + baseWorkspaceId + '/update',
      { name: 'Extra ' + runId, surprise: true },
      writerKey.key,
    );
    expect(extra.status).toBe(400);
    const missing = await api(
      'POST',
      '/genapi/workspaces/' + baseWorkspaceId + '/update',
      {},
      writerKey.key,
    );
    expect(missing.status).toBe(400);

    const storedName = (await prisma.workspace.findUnique({
      where: { id: baseWorkspaceId },
      select: { name: true },
    }))?.name;
    expect(storedName).toBe(nameBefore);
    expect(await auditCount()).toBe(before);
  });

  it('race: double-tapped rename lands two clean successes on one row', async () => {
    const before = await auditCount();
    const target = await keyedCreateWorkspace('Double Tap ' + runId, writerKey, organizationId);
    const nameA = 'Double A ' + runId;
    const nameB = 'Double B ' + runId;

    const rename = (name: string) => api(
      'POST',
      '/genapi/workspaces/' + target.id + '/update',
      { name },
      writerKey.key,
    );
    const raced = await Promise.all([rename(nameA), rename(nameB)]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(201);

    const stored = await prisma.workspace.findUnique({
      where: { id: target.id },
      select: { name: true, slug: true, organizationId: true },
    });
    expect([nameA, nameB]).toContain(stored?.name);
    expect(stored?.slug).toBe(target.slug);
    expect(stored?.organizationId).toBe(organizationId);

    expect(await auditCount()).toBe(before);
  });

  it('race: keyed rename against JWT rename ends in one clean final state', async () => {
    const target = await keyedCreateWorkspace('Cross Race ' + runId, writerKey, organizationId);
    const keyedName = 'Cross Keyed ' + runId;
    const jwtName = 'Cross Jwt ' + runId;

    const raced = await Promise.all([
      api('POST', '/genapi/workspaces/' + target.id + '/update', { name: keyedName }, writerKey.key),
      api('PATCH', '/workspaces/' + target.id, { name: jwtName }, hank.tokens.accessToken),
    ]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(200);

    const stored = await prisma.workspace.findUnique({
      where: { id: target.id },
      select: { name: true, slug: true },
    });
    expect([keyedName, jwtName]).toContain(stored?.name);
    expect(stored?.slug).toBe(target.slug);
  });

  it('race: rename against a JWT project create inside the workspace', async () => {
    const target = await keyedCreateWorkspace('Project Race ' + runId, writerKey, organizationId);
    const renameTo = 'Project Race Renamed ' + runId;

    const raced = await Promise.all([
      api('POST', '/genapi/workspaces/' + target.id + '/update', { name: renameTo }, writerKey.key),
      api('POST', '/workspaces/' + target.id + '/projects', { name: 'Race Project ' + runId }, hank.tokens.accessToken),
    ]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(201);

    const projectRow = raced[1].body as { id: string };
    const storedProject = await prisma.project.findUnique({
      where: { id: projectRow.id },
      select: { workspaceId: true, name: true },
    });
    expect(storedProject?.workspaceId).toBe(target.id);
    expect(storedProject?.name).toBe('Race Project ' + runId);

    const stored = await prisma.workspace.findUnique({
      where: { id: target.id },
      select: { name: true, slug: true },
    });
    expect(stored?.name).toBe(renameTo);
    expect(stored?.slug).toBe(target.slug);
  });

  it('tenant-bounds every rename to the key organization', async () => {
    const before = await auditCount();

    const hers = await api(
      'POST',
      '/genapi/workspaces/' + irisWorkspaceId + '/update',
      { name: 'Iris Renamed ' + runId },
      irisWriterKey.key,
    );
    expect(hers.status).toBe(201);
    const hersRow = hers.body as { name: string; slug: string; organizationId: string };
    expect(hersRow.name).toBe('Iris Renamed ' + runId);
    expect(hersRow.slug).toBe(irisWorkspaceSlug);
    expect(hersRow.organizationId).toBe(foreignOrganizationId);

    const irisList = await api('GET', '/genapi/workspaces', undefined, irisWriterKey.key);
    expect(irisList.status).toBe(200);
    const irisEntry = (irisList.body as unknown as Array<{ id: string; name: string }>)
      .find((r) => r.id === irisWorkspaceId);
    expect(irisEntry?.name).toBe('Iris Renamed ' + runId);

    const hankList = await api('GET', '/genapi/workspaces', undefined, readerKey.key);
    expect(hankList.status).toBe(200);
    const hankIds = new Set((hankList.body as unknown as Array<{ id: string }>).map((r) => r.id));
    expect(hankIds.has(irisWorkspaceId)).toBe(false);

    const notFound = new Set<string>();
    const hankIntoIris = await api(
      'POST',
      '/genapi/workspaces/' + irisWorkspaceId + '/update',
      { name: 'Hank Hijack ' + runId },
      writerKey.key,
    );
    expect(hankIntoIris.status).toBe(404);
    notFound.add((hankIntoIris.body as { message: string }).message);
    const irisIntoHank = await api(
      'POST',
      '/genapi/workspaces/' + baseWorkspaceId + '/update',
      { name: 'Iris Hijack ' + runId },
      irisWriterKey.key,
    );
    expect(irisIntoHank.status).toBe(404);
    notFound.add((irisIntoHank.body as { message: string }).message);
    expect(notFound.size).toBe(1);
    expect(Array.from(notFound)[0]).toBe('Workspace not found.');

    expect(await auditCount()).toBe(before);
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const rowsBefore = await workspaceRowsInOrganization();
    const nameBefore = (await prisma.workspace.findUnique({
      where: { id: baseWorkspaceId },
      select: { name: true },
    }))?.name;

    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect([200, 201]).toContain(revoke.status);

    const revokedRename = await api(
      'POST',
      '/genapi/workspaces/' + baseWorkspaceId + '/update',
      { name: 'Revoked Try ' + runId },
      revokedKey.key,
    );
    expect(revokedRename.status).toBe(401);
    expect((revokedRename.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredRename = await api(
      'POST',
      '/genapi/workspaces/' + baseWorkspaceId + '/update',
      { name: 'Expired Try ' + runId },
      shortLivedKey.key,
    );
    expect(expiredRename.status).toBe(401);
    expect((expiredRename.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const anonymous = await api(
      'POST',
      '/genapi/workspaces/' + baseWorkspaceId + '/update',
      { name: 'Anonymous Try ' + runId },
    );
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { message: string }).message).toBe('A valid GENESIS API key is required.');

    expect(await workspaceRowsInOrganization()).toBe(rowsBefore);
    const storedName = (await prisma.workspace.findUnique({
      where: { id: baseWorkspaceId },
      select: { name: true },
    }))?.name;
    expect(storedName).toBe(nameBefore);
  });
});
