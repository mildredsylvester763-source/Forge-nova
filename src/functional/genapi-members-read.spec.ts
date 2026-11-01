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
 * Keyed organization member directory over the real app and the real
 * CI PostgreSQL. Grounded in the GitHub org members listing: reading
 * who belongs to an organization needs only the Members organization
 * read permission, so a READ_ORGANIZATION key is an admin-delegated
 * directory read exactly like the audit trail delegation. The key IS
 * the tenant bound - there is no path parameter to probe, so the
 * directory can only ever be the one of the key organization, the
 * rows mirror the JWT member listing exactly through the shared core
 * (oldest first, the same nested user shape), and reads never write
 * audit rows.
 */
suite('GENESIS keyed member directory flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let hank: UserContext;
  let sam: UserContext;
  let iris: UserContext;
  let tess: UserContext;
  let organizationId = '';
  let foreignOrganizationId = '';
  let samMembershipId = '';
  let readerKey: KeyContext;
  let projectWriterKey: KeyContext;
  let appWriterKey: KeyContext;
  let shortLivedKey: KeyContext;
  let revokedKey: KeyContext;
  let irisReaderKey: KeyContext;
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);
  const password = 'gmr-members-read-password-123';

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
    const email = 'genesis-gmr-' + name + '-' + runId + '@example.com';
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

  it('seeds two organizations, a second member, and scoped keys', async () => {
    hank = await registerUser('hank');
    sam = await registerUser('sam');
    iris = await registerUser('iris');
    tess = await registerUser('tess');

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const addSam = await api(
      'POST',
      '/organizations/' + organizationId + '/members',
      { email: sam.email, role: 'DEVELOPER' },
      hank.tokens.accessToken,
    );
    expect(addSam.status).toBe(201);
    samMembershipId = (addSam.body as { id: string }).id;

    readerKey = await createKey(hank.tokens.accessToken, organizationId, 'Org Reader', ['READ_ORGANIZATION']);
    projectWriterKey = await createKey(hank.tokens.accessToken, organizationId, 'Project Writer', ['READ_PROJECTS', 'WRITE_PROJECTS']);
    appWriterKey = await createKey(hank.tokens.accessToken, organizationId, 'App Writer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Short Lived',
      ['READ_ORGANIZATION'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(hank.tokens.accessToken, organizationId, 'Revoked', ['READ_ORGANIZATION']);
    irisReaderKey = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Iris Reader', ['READ_ORGANIZATION']);
  });

  it('mirrors the JWT member listing exactly through the shared core', async () => {
    const before = await auditCount();

    const keyed = await api('GET', '/genapi/members', undefined, readerKey.key);
    expect(keyed.status).toBe(200);
    const jwt = await api(
      'GET',
      '/organizations/' + organizationId + '/members',
      undefined,
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(200);
    expect(keyed.body).toEqual(jwt.body);

    const rows = keyed.body as unknown as Array<{
      id: string;
      role: string;
      createdAt: string;
      user: { id: string; email: string; displayName: string; status: string };
    }>;
    expect(rows.length).toBe(2);
    expect(rows[0].user.email).toBe(hank.email);
    expect(rows[0].role).toBe('OWNER');
    expect(rows[1].user.email).toBe(sam.email);
    expect(rows[1].role).toBe('DEVELOPER');
    expect(new Date(rows[0].createdAt).getTime()).toBeLessThanOrEqual(new Date(rows[1].createdAt).getTime());
    expect(Object.keys(rows[0]).sort()).toEqual(['createdAt', 'id', 'role', 'user']);
    expect(Object.keys(rows[0].user).sort()).toEqual(['displayName', 'email', 'id', 'status']);
    expect(rows.every((r) => r.user.status === 'ACTIVE')).toBe(true);

    expect(await auditCount()).toBe(before);
  });

  it('reflects a JWT role change on the keyed directory', async () => {
    const change = await api(
      'PATCH',
      '/organizations/' + organizationId + '/members/' + samMembershipId,
      { role: 'VIEWER' },
      hank.tokens.accessToken,
    );
    expect(change.status).toBe(200);

    const before = await auditCount();
    const keyed = await api('GET', '/genapi/members', undefined, readerKey.key);
    expect(keyed.status).toBe(200);
    const rows = keyed.body as unknown as Array<{ id: string; role: string; user: { email: string } }>;
    expect(rows.length).toBe(2);
    const samRow = rows.find((r) => r.id === samMembershipId);
    expect(samRow?.role).toBe('VIEWER');
    expect(samRow?.user.email).toBe(sam.email);

    expect(await auditCount()).toBe(before);
  });

  it('double-tapped identical reads answer identical directories', async () => {
    const before = await auditCount();

    const raced = await Promise.all([
      api('GET', '/genapi/members', undefined, readerKey.key),
      api('GET', '/genapi/members', undefined, readerKey.key),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(200);
    expect(raced[0].body).toEqual(raced[1].body);

    expect(await auditCount()).toBe(before);
  });

  it('race: keyed directory read against a JWT member add', async () => {
    const raced = await Promise.all([
      api('GET', '/genapi/members', undefined, readerKey.key),
      api(
        'POST',
        '/organizations/' + organizationId + '/members',
        { email: tess.email, role: 'DEVELOPER' },
        hank.tokens.accessToken,
      ),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(201);

    const snapshot = raced[0].body as unknown as Array<{ user: { email: string } }>;
    expect([2, 3]).toContain(snapshot.length);
    const emails = snapshot.map((r) => r.user.email);
    expect(new Set(emails).size).toBe(emails.length);

    const keyed = await api('GET', '/genapi/members', undefined, readerKey.key);
    expect(keyed.status).toBe(200);
    const after = keyed.body as unknown as Array<{ role: string; user: { email: string } }>;
    expect(after.length).toBe(3);
    const tessRow = after.find((r) => r.user.email === tess.email);
    expect(tessRow?.role).toBe('DEVELOPER');

    const jwt = await api(
      'GET',
      '/organizations/' + organizationId + '/members',
      undefined,
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(200);
    expect(jwt.body).toEqual(keyed.body);
  });

  it('refuses wrong-scope keys with one identical message and zero side effects', async () => {
    const before = await auditCount();

    const scopeMessages = new Set<string>();
    for (const wrongKey of [projectWriterKey, appWriterKey]) {
      const refused = await api('GET', '/genapi/members', undefined, wrongKey.key);
      expect(refused.status).toBe(403);
      scopeMessages.add((refused.body as { message: string }).message);
    }
    expect(scopeMessages.size).toBe(1);
    expect(Array.from(scopeMessages)[0]).toBe('The API key does not grant the required scope.');

    expect(await auditCount()).toBe(before);
  });

  it('tenant-bounds the directory to the key organization', async () => {
    const before = await auditCount();

    const irisListing = await api('GET', '/genapi/members', undefined, irisReaderKey.key);
    expect(irisListing.status).toBe(200);
    const irisRows = irisListing.body as unknown as Array<{ user: { email: string } }>;
    expect(irisRows.length).toBe(1);
    expect(irisRows[0].user.email).toBe(iris.email);

    const hankListing = await api('GET', '/genapi/members', undefined, readerKey.key);
    expect(hankListing.status).toBe(200);
    const hankEmails = new Set(
      (hankListing.body as unknown as Array<{ user: { email: string } }>).map((r) => r.user.email),
    );
    expect(hankEmails.has(iris.email)).toBe(false);

    const irisEmails = new Set(irisRows.map((r) => r.user.email));
    for (const email of [hank.email, sam.email, tess.email]) {
      expect(irisEmails.has(email)).toBe(false);
    }

    expect(await auditCount()).toBe(before);
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect([200, 201]).toContain(revoke.status);

    const revokedRead = await api('GET', '/genapi/members', undefined, revokedKey.key);
    expect(revokedRead.status).toBe(401);
    expect((revokedRead.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredRead = await api('GET', '/genapi/members', undefined, shortLivedKey.key);
    expect(expiredRead.status).toBe(401);
    expect((expiredRead.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const anonymous = await api('GET', '/genapi/members');
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { message: string }).message).toBe('A valid GENESIS API key is required.');
  });
});
