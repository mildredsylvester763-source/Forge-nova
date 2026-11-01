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
 * Keyed organization profile over the real app and the real CI
 * PostgreSQL. Grounded in the GitHub get-an-organization REST
 * surface: the organization profile read is a first-class endpoint,
 * a fine-grained token with organization access reads the profile
 * without any extra permissions, and the profile fields and live
 * counts must answer the same truth the JWT organization listing
 * rows carry. The key IS the tenant bound, so there is no path
 * parameter to probe, the profile comes from the same shared
 * profile select the JWT listing uses, and reads never write audit
 * rows. The counts are live, so count assertions are always
 * anchored in prisma ground truth scoped by organizationId.
 */
suite('GENESIS keyed organization profile flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId = '';
  let foreignOrganizationId = '';
  let readerKey: KeyContext;
  let writerKey: KeyContext;
  let appReaderKey: KeyContext;
  let shortLivedKey: KeyContext;
  let revokedKey: KeyContext;
  let irisReaderKey: KeyContext;
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);
  const password = 'gop-org-profile-password-123';

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
    const email = 'genesis-gop-' + name + '-' + runId + '@example.com';
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
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it('seeds two organizations, a key rack, and a second workspace', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;

    readerKey = await createKey(hank.tokens.accessToken, organizationId, 'Org Reader', ['READ_ORGANIZATION']);
    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'Org Writer', ['READ_ORGANIZATION', 'WRITE_ORGANIZATION']);
    appReaderKey = await createKey(hank.tokens.accessToken, organizationId, 'App Reader', ['READ_APPLICATIONS']);
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Short Lived',
      ['READ_ORGANIZATION'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(hank.tokens.accessToken, organizationId, 'Revoked', ['READ_ORGANIZATION']);
    irisReaderKey = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Iris Reader', ['READ_ORGANIZATION']);

    const second = await api('POST', '/genapi/workspaces', { name: 'Second Space' }, writerKey.key);
    expect(second.status).toBe(201);
  });

  it('answers the exact profile shape with live counts', async () => {
    const before = await auditCount(organizationId);

    const profile = await api('GET', '/genapi/organization', undefined, readerKey.key);
    expect(profile.status).toBe(200);
    const row = profile.body as unknown as {
      id: string;
      name: string;
      slug: string;
      createdAt: string;
      _count: { memberships: number; workspaces: number };
    };
    expect(Object.keys(row).sort()).toEqual(['_count', 'createdAt', 'id', 'name', 'slug']);
    expect(Object.keys(row._count).sort()).toEqual(['memberships', 'workspaces']);
    expect(row.id).toBe(organizationId);
    expect(row.name).toBe('Personal Workspace');
    expect(typeof row.slug).toBe('string');
    expect(row.slug.length).toBeGreaterThan(0);
    expect(row._count.memberships).toBe(1);
    expect(row._count.workspaces).toBe(2);

    expect(await auditCount(organizationId)).toBe(before);
  });

  it('mirrors the JWT organization listing row exactly through the shared select', async () => {
    const before = await auditCount(organizationId);

    const keyed = await api('GET', '/genapi/organization', undefined, readerKey.key);
    expect(keyed.status).toBe(200);
    const jwt = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(jwt.status).toBe(200);
    const jwtRows = jwt.body as unknown as Array<Record<string, unknown> & { id: string }>;
    const jwtRow = jwtRows.find((candidate) => candidate.id === organizationId);
    expect(jwtRow).toBeDefined();
    delete jwtRow!.memberships;
    expect(keyed.body).toEqual(jwtRow);

    expect(await auditCount(organizationId)).toBe(before);
  });

  it('answers database ground truth, counts included', async () => {
    const before = await auditCount(organizationId);

    const profile = await api('GET', '/genapi/organization', undefined, readerKey.key);
    expect(profile.status).toBe(200);
    const row = profile.body as unknown as {
      id: string;
      name: string;
      slug: string;
      createdAt: string;
      _count: { memberships: number; workspaces: number };
    };
    const truth = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        _count: { select: { memberships: true, workspaces: true } },
      },
    });
    expect(truth).not.toBeNull();
    expect(row.id).toBe(truth!.id);
    expect(row.name).toBe(truth!.name);
    expect(row.slug).toBe(truth!.slug);
    expect(row.createdAt).toBe(truth!.createdAt.toISOString());
    expect(row._count.memberships).toBe(truth!._count.memberships);
    expect(row._count.workspaces).toBe(truth!._count.workspaces);
    expect(row._count.memberships).toBe(await prisma.membership.count({ where: { organizationId } }));
    expect(row._count.workspaces).toBe(await prisma.workspace.count({ where: { organizationId } }));

    expect(await auditCount(organizationId)).toBe(before);
  });

  it('reflects organization growth live in the counts', async () => {
    const before = await auditCount(organizationId);

    const first = await api('GET', '/genapi/organization', undefined, readerKey.key);
    expect(first.status).toBe(200);
    const beforeRow = first.body as unknown as { _count: { memberships: number; workspaces: number } };

    const third = await api('POST', '/genapi/workspaces', { name: 'Third Space' }, writerKey.key);
    expect(third.status).toBe(201);

    const second = await api('GET', '/genapi/organization', undefined, readerKey.key);
    expect(second.status).toBe(200);
    const afterRow = second.body as unknown as { _count: { memberships: number; workspaces: number } };
    expect(afterRow._count.workspaces).toBe(beforeRow._count.workspaces + 1);
    expect(afterRow._count.memberships).toBe(beforeRow._count.memberships);
    expect(afterRow._count.workspaces).toBe(await prisma.workspace.count({ where: { organizationId } }));

    expect(await auditCount(organizationId)).toBe(before);
  });

  it('double-tapped identical reads answer identical profiles', async () => {
    const before = await auditCount(organizationId);

    const raced = await Promise.all([
      api('GET', '/genapi/organization', undefined, readerKey.key),
      api('GET', '/genapi/organization', undefined, readerKey.key),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(200);
    expect(raced[0].body).toEqual(raced[1].body);

    expect(await auditCount(organizationId)).toBe(before);
  });

  it('race: keyed profile read against a keyed workspace create', async () => {
    const before = await auditCount(organizationId);
    const beforeCount = await prisma.workspace.count({ where: { organizationId } });

    const raced = await Promise.all([
      api('GET', '/genapi/organization', undefined, readerKey.key),
      api('POST', '/genapi/workspaces', { name: 'Raced Space' }, writerKey.key),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(201);
    const snapshot = raced[0].body as unknown as { _count: { workspaces: number } };
    expect([beforeCount, beforeCount + 1]).toContain(snapshot._count.workspaces);

    expect(await prisma.workspace.count({ where: { organizationId } })).toBe(beforeCount + 1);
    const keyed = await api('GET', '/genapi/organization', undefined, readerKey.key);
    expect(keyed.status).toBe(200);
    const jwt = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(jwt.status).toBe(200);
    const jwtRows = jwt.body as unknown as Array<Record<string, unknown> & { id: string }>;
    const jwtRow = jwtRows.find((candidate) => candidate.id === organizationId);
    expect(jwtRow).toBeDefined();
    delete jwtRow!.memberships;
    expect(keyed.body).toEqual(jwtRow);

    expect(await auditCount(organizationId)).toBe(before);
  });

  it('refuses a wrong-scope key with one identical message and zero side effects', async () => {
    const before = await auditCount(organizationId);

    const refused = await api('GET', '/genapi/organization', undefined, appReaderKey.key);
    expect(refused.status).toBe(403);
    expect((refused.body as { message: string }).message).toBe('The API key does not grant the required scope.');

    expect(await auditCount(organizationId)).toBe(before);
  });

  it('tenant-bounds the profile to the key organization', async () => {
    const beforeHank = await auditCount(organizationId);
    const beforeIris = await auditCount(foreignOrganizationId);

    const hankProfile = await api('GET', '/genapi/organization', undefined, readerKey.key);
    expect(hankProfile.status).toBe(200);
    expect((hankProfile.body as { id: string }).id).toBe(organizationId);

    const irisProfile = await api('GET', '/genapi/organization', undefined, irisReaderKey.key);
    expect(irisProfile.status).toBe(200);
    const irisRow = irisProfile.body as unknown as { id: string; name: string; slug: string };
    expect(irisRow.id).toBe(foreignOrganizationId);
    expect(irisRow.id).not.toBe(organizationId);
    expect(irisRow.slug).not.toBe((hankProfile.body as { slug: string }).slug);

    const irisJwt = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisJwt.status).toBe(200);
    const irisJwtRows = irisJwt.body as unknown as Array<Record<string, unknown> & { id: string }>;
    const irisJwtRow = irisJwtRows.find((candidate) => candidate.id === foreignOrganizationId);
    expect(irisJwtRow).toBeDefined();
    delete irisJwtRow!.memberships;
    expect(irisProfile.body).toEqual(irisJwtRow);

    expect(await auditCount(organizationId)).toBe(beforeHank);
    expect(await auditCount(foreignOrganizationId)).toBe(beforeIris);
  });

  it('never writes audit rows for profile reads', async () => {
    const beforeHank = await auditCount(organizationId);
    const beforeIris = await auditCount(foreignOrganizationId);

    const burst = await Promise.all([
      api('GET', '/genapi/organization', undefined, readerKey.key),
      api('GET', '/genapi/organization', undefined, readerKey.key),
      api('GET', '/genapi/me', undefined, readerKey.key),
      api('GET', '/genapi/organization', undefined, irisReaderKey.key),
    ]);
    for (const response of burst) {
      expect(response.status).toBe(200);
    }

    expect(await auditCount(organizationId)).toBe(beforeHank);
    expect(await auditCount(foreignOrganizationId)).toBe(beforeIris);
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect([200, 201]).toContain(revoke.status);

    const revokedRead = await api('GET', '/genapi/organization', undefined, revokedKey.key);
    expect(revokedRead.status).toBe(401);
    expect((revokedRead.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredRead = await api('GET', '/genapi/organization', undefined, shortLivedKey.key);
    expect(expiredRead.status).toBe(401);
    expect((expiredRead.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const anonymous = await api('GET', '/genapi/organization');
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { message: string }).message).toBe('A valid GENESIS API key is required.');
  });
});
