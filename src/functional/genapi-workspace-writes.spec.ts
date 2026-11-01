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
 * Keyed workspace create surface over the real app and the real CI
 * PostgreSQL. Grounded in the GitHub team create REST surface:
 * creating an organization grouping structure needs the organization
 * level write permission, the team is always created inside the
 * organization the token belongs to, and GitHub derives the team slug
 * from the name server-side. Keys are minted only by organization
 * admins, so a WRITE_ORGANIZATION key is an admin-delegated create,
 * the keyed create mirrors the JWT create exactly through the shared
 * persist core, and a body organization other than the key
 * organization answers the same uniform 404 the JWT admin gate gives.
 * Creates never write audit rows because the JWT create writes none,
 * and racing creates land two honest workspaces because the slug
 * suffix is random per create, exactly like GitHub team slugs.
 */
suite('GENESIS keyed workspace create flows (real app, real database)', () => {
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
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);
  const password = 'gww-workspace-writes-password-123';

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
    const email = 'genesis-gww-' + name + '-' + runId + '@example.com';
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
  });

  it('mirrors the JWT create exactly through the shared core', async () => {
    const before = await auditCount();

    const keyed = await api(
      'POST',
      '/genapi/workspaces',
      { name: '  Keyed Workspace ' + runId + '  ', organizationId },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    const jwt = await api(
      'POST',
      '/workspaces',
      { name: 'Jwt Workspace ' + runId, organizationId },
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(201);
    expect(Object.keys(keyed.body).sort()).toEqual(Object.keys(jwt.body).sort());

    const row = keyed.body as {
      id: string;
      organizationId: string;
      name: string;
      slug: string;
      createdAt: string;
    };
    expect(row.name).toBe('Keyed Workspace ' + runId);
    expect(row.organizationId).toBe(organizationId);
    expect(row.slug).toMatch(/^keyed-workspace-[a-z0-9]+-[0-9a-f]{8}$/);

    const stored = await prisma.workspace.findUnique({
      where: { id: row.id },
      select: { organizationId: true, name: true, slug: true },
    });
    expect(stored).toEqual({
      organizationId,
      name: 'Keyed Workspace ' + runId,
      slug: row.slug,
    });

    const keyedList = await api('GET', '/genapi/workspaces', undefined, readerKey.key);
    expect(keyedList.status).toBe(200);
    expect((keyedList.body as unknown as Array<{ id: string }>).some((r) => r.id === row.id)).toBe(true);
    const jwtList = await api('GET', '/workspaces', undefined, hank.tokens.accessToken);
    expect(jwtList.status).toBe(200);
    expect((jwtList.body as unknown as Array<{ id: string }>).some((r) => r.id === row.id)).toBe(true);

    expect(await auditCount()).toBe(before);
  });

  it('derives slugs from names with the same laws as the JWT surface', async () => {
    const special = await api(
      'POST',
      '/genapi/workspaces',
      { name: '  Payments & Data  ', organizationId },
      writerKey.key,
    );
    expect(special.status).toBe(201);
    const specialRow = special.body as { name: string; slug: string };
    expect(specialRow.name).toBe('Payments & Data');
    expect(specialRow.slug).toMatch(/^payments-data-[0-9a-f]{8}$/);

    const long = await api(
      'POST',
      '/genapi/workspaces',
      { name: 'z'.repeat(120), organizationId },
      writerKey.key,
    );
    expect(long.status).toBe(201);
    expect((long.body as { slug: string }).slug).toMatch(/^z{64}-[0-9a-f]{8}$/);

    const symbols = await api(
      'POST',
      '/genapi/workspaces',
      { name: '---', organizationId },
      writerKey.key,
    );
    expect(symbols.status).toBe(201);
    expect((symbols.body as { slug: string }).slug).toMatch(/^workspace-[0-9a-f]{8}$/);
  });

  it('refuses create attempts without side effects', async () => {
    const before = await auditCount();
    const rowsBefore = await workspaceRowsInOrganization();

    const scopeMessages = new Set<string>();
    for (const wrongKey of [readerKey, projectWriterKey, appWriterKey]) {
      const refused = await api(
        'POST',
        '/genapi/workspaces',
        { name: 'Refused ' + runId, organizationId },
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
      '/genapi/workspaces',
      { name: 'Foreign Try ' + runId, organizationId: foreignOrganizationId },
      writerKey.key,
    );
    expect(foreign.status).toBe(404);
    notFound.add((foreign.body as { message: string }).message);
    const unknown = await api(
      'POST',
      '/genapi/workspaces',
      { name: 'Unknown Try ' + runId, organizationId: 'does-not-exist-at-all' },
      writerKey.key,
    );
    expect(unknown.status).toBe(404);
    notFound.add((unknown.body as { message: string }).message);
    expect(notFound.size).toBe(1);
    expect(Array.from(notFound)[0]).toBe('Organization not found.');

    const blank = await api('POST', '/genapi/workspaces', { name: '   ', organizationId }, writerKey.key);
    expect(blank.status).toBe(400);
    const longName = await api('POST', '/genapi/workspaces', { name: 'x'.repeat(121), organizationId }, writerKey.key);
    expect(longName.status).toBe(400);
    const extra = await api(
      'POST',
      '/genapi/workspaces',
      { name: 'Extra ' + runId, organizationId, surprise: true },
      writerKey.key,
    );
    expect(extra.status).toBe(400);
    const missingOrg = await api('POST', '/genapi/workspaces', { name: 'Missing ' + runId }, writerKey.key);
    expect(missingOrg.status).toBe(400);

    expect(await workspaceRowsInOrganization()).toBe(rowsBefore);
    expect(await auditCount()).toBe(before);
  });

  it('race: double-tapped create lands two honest workspaces', async () => {
    const before = await auditCount();
    const rowsBefore = await workspaceRowsInOrganization();
    const name = 'Race Double ' + runId;

    const create = () => api(
      'POST',
      '/genapi/workspaces',
      { name, organizationId },
      writerKey.key,
    );
    const raced = await Promise.all([create(), create()]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(201);

    const first = raced[0].body as { id: string; slug: string };
    const second = raced[1].body as { id: string; slug: string };
    expect(first.id).not.toBe(second.id);
    expect(first.slug).not.toBe(second.slug);

    expect(await workspaceRowsInOrganization()).toBe(rowsBefore + 2);
    const storedNames = await prisma.workspace.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { name: true, organizationId: true },
    });
    expect(storedNames.every((r) => r.name === name && r.organizationId === organizationId)).toBe(true);

    expect(await auditCount()).toBe(before);
  });

  it('race: keyed create against JWT create', async () => {
    const name = 'Race Cross ' + runId;

    const raced = await Promise.all([
      api('POST', '/genapi/workspaces', { name, organizationId }, writerKey.key),
      api('POST', '/workspaces', { name, organizationId }, hank.tokens.accessToken),
    ]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(201);
    const keyedRow = raced[0].body as { id: string };
    const jwtRow = raced[1].body as { id: string };
    expect(keyedRow.id).not.toBe(jwtRow.id);

    const jwtList = await api('GET', '/workspaces', undefined, hank.tokens.accessToken);
    const ids = new Set((jwtList.body as unknown as Array<{ id: string }>).map((r) => r.id));
    expect(ids.has(keyedRow.id)).toBe(true);
    expect(ids.has(jwtRow.id)).toBe(true);
  });

  it('tenant-bounds every create to the key organization', async () => {
    const before = await auditCount();

    const hers = await api(
      'POST',
      '/genapi/workspaces',
      { name: 'Iris Keyed Workspace ' + runId, organizationId: foreignOrganizationId },
      irisWriterKey.key,
    );
    expect(hers.status).toBe(201);
    const hersRow = hers.body as { id: string; organizationId: string };
    expect(hersRow.organizationId).toBe(foreignOrganizationId);

    const hankList = await api('GET', '/genapi/workspaces', undefined, readerKey.key);
    expect(hankList.status).toBe(200);
    const hankIds = new Set((hankList.body as unknown as Array<{ id: string }>).map((r) => r.id));
    expect(hankIds.has(hersRow.id)).toBe(false);

    const irisList = await api('GET', '/genapi/workspaces', undefined, irisWriterKey.key);
    expect(irisList.status).toBe(200);
    const irisIds = new Set((irisList.body as unknown as Array<{ id: string }>).map((r) => r.id));
    expect(irisIds.has(hersRow.id)).toBe(true);

    const notFound = new Set<string>();
    const hankIntoForeign = await api(
      'POST',
      '/genapi/workspaces',
      { name: 'Hank Foreign Try ' + runId, organizationId: foreignOrganizationId },
      writerKey.key,
    );
    expect(hankIntoForeign.status).toBe(404);
    notFound.add((hankIntoForeign.body as { message: string }).message);
    const irisIntoHank = await api(
      'POST',
      '/genapi/workspaces',
      { name: 'Iris Hijack Try ' + runId, organizationId },
      irisWriterKey.key,
    );
    expect(irisIntoHank.status).toBe(404);
    notFound.add((irisIntoHank.body as { message: string }).message);
    expect(notFound.size).toBe(1);
    expect(Array.from(notFound)[0]).toBe('Organization not found.');

    expect(await auditCount()).toBe(before);
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const rowsBefore = await workspaceRowsInOrganization();

    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect([200, 201]).toContain(revoke.status);

    const revokedCreate = await api(
      'POST',
      '/genapi/workspaces',
      { name: 'Revoked Try ' + runId, organizationId },
      revokedKey.key,
    );
    expect(revokedCreate.status).toBe(401);
    expect((revokedCreate.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredCreate = await api(
      'POST',
      '/genapi/workspaces',
      { name: 'Expired Try ' + runId, organizationId },
      shortLivedKey.key,
    );
    expect(expiredCreate.status).toBe(401);
    expect((expiredCreate.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const anonymous = await api(
      'POST',
      '/genapi/workspaces',
      { name: 'Anonymous Try ' + runId, organizationId },
    );
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { message: string }).message).toBe('A valid GENESIS API key is required.');

    expect(await workspaceRowsInOrganization()).toBe(rowsBefore);
  });
});
