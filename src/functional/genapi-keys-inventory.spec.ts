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
 * Keyed API key inventory over the real app and the real CI PostgreSQL.
 * Grounded in the GitHub organization token review surface: organization
 * owners review the member token inventory with metadata only (owner,
 * scopes, expiry, last usage) and never the raw secrets, while Stripe
 * keeps key management dashboard-only with no public listing API at all.
 * GENESIS follows the API-exposed GitHub model - a READ_ORGANIZATION key
 * is an admin-delegated inventory read. The key IS the tenant bound, so
 * there is no path parameter to probe, the rows mirror the JWT listing
 * exactly through the shared core (newest first, masked hints only),
 * and reads never write audit rows. The one nondeterministic field is
 * lastUsedAt: the guard records usage with a fire-and-forget update that
 * is not awaited before the handler query, so equality comparisons
 * strip that field and a monotonic law pins it down instead.
 */
suite('GENESIS keyed key inventory flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId = '';
  let foreignOrganizationId = '';
  let readerKey: KeyContext;
  let projectWriterKey: KeyContext;
  let appWriterKey: KeyContext;
  let shortLivedKey: KeyContext;
  let revokedKey: KeyContext;
  let doomedKey: KeyContext;
  let irisReaderKey: KeyContext;
  let warmTime = 0;
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);
  const password = 'gki-keys-inventory-password-123';

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
    const email = 'genesis-gki-' + name + '-' + runId + '@example.com';
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

  // The guard stamps lastUsedAt with a fire-and-forget update that races
  // the handler query, so equality comparisons strip the field and the
  // monotonic law covers it instead.
  const stripLastUsedAt = (listing: unknown) => {
    return (listing as Array<Record<string, unknown>>).map((row) => {
      const copy = { ...row };
      delete copy.lastUsedAt;
      return copy;
    });
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

  it('seeds two organizations, a full key rack, and warms the acting key', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;

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
    doomedKey = await createKey(hank.tokens.accessToken, organizationId, 'Doomed', ['READ_ORGANIZATION']);
    irisReaderKey = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Iris Reader', ['READ_ORGANIZATION']);

    warmTime = Date.now();
    const warm = await api('GET', '/genapi/me', undefined, readerKey.key);
    expect(warm.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 2500));
  });

  it('mirrors the JWT key listing exactly through the shared core', async () => {
    const before = await auditCount();

    const keyed = await api('GET', '/genapi/api-keys', undefined, readerKey.key);
    expect(keyed.status).toBe(200);
    const jwt = await api(
      'GET',
      '/organizations/' + organizationId + '/api-keys',
      undefined,
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(200);
    expect(stripLastUsedAt(keyed.body)).toEqual(stripLastUsedAt(jwt.body));

    const rows = keyed.body as unknown as Array<Record<string, unknown> & { id: string; createdAt: string }>;
    expect(rows.length).toBe(6);
    for (let i = 1; i < rows.length; i += 1) {
      expect(new Date(rows[i - 1].createdAt).getTime())
        .toBeGreaterThanOrEqual(new Date(rows[i].createdAt).getTime());
    }
    expect(Object.keys(rows[0]).sort()).toEqual([
      'createdAt',
      'createdBy',
      'displayHint',
      'expiresAt',
      'id',
      'lastUsedAt',
      'name',
      'organizationId',
      'revokedAt',
      'scopes',
      'updatedAt',
    ]);
    expect(JSON.stringify(keyed.body).includes('hashedKey')).toBe(false);

    expect(await auditCount()).toBe(before);
  });

  it('answers metadata only: every raw key stays out of the listing', async () => {
    const before = await auditCount();

    const listing = await api('GET', '/genapi/api-keys', undefined, readerKey.key);
    expect(listing.status).toBe(200);
    const raw = JSON.stringify(listing.body);
    const rack = [readerKey, projectWriterKey, appWriterKey, shortLivedKey, revokedKey, doomedKey, irisReaderKey];
    for (const key of rack) {
      expect(raw.includes(key.key)).toBe(false);
    }
    const rows = listing.body as unknown as Array<{ id: string; displayHint: unknown }>;
    for (const row of rows) {
      expect(typeof row.displayHint).toBe('string');
    }
    const hintsById = new Map(rows.map((row) => [row.id, row.displayHint as string]));
    for (const key of [readerKey, projectWriterKey, appWriterKey, shortLivedKey, revokedKey, doomedKey]) {
      const hint = hintsById.get(key.id) as string;
      expect(hint.includes(key.key)).toBe(false);
      expect(hint).not.toBe(key.key);
    }

    expect(await auditCount()).toBe(before);
  });

  it('stamps lastUsedAt monotonically despite the fire-and-forget update', async () => {
    const listing = await api('GET', '/genapi/api-keys', undefined, readerKey.key);
    expect(listing.status).toBe(200);
    const rows = listing.body as unknown as Array<{ id: string; lastUsedAt: string | null }>;
    const readerRow = rows.find((row) => row.id === readerKey.id);
    expect(readerRow).toBeDefined();
    expect(typeof readerRow?.lastUsedAt).toBe('string');
    expect(new Date(readerRow?.lastUsedAt as string).getTime()).toBeGreaterThanOrEqual(warmTime);
  });

  it('surfaces a JWT revocation as a masked revoked row plus exactly one audit row', async () => {
    const before = await auditCount();

    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + doomedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect([200, 201]).toContain(revoke.status);
    expect(await auditCount()).toBe(before + 1);
    expect(await prisma.auditEvent.count({ where: { organizationId, action: 'apikey.revoke' } })).toBe(1);

    const listing = await api('GET', '/genapi/api-keys', undefined, readerKey.key);
    expect(listing.status).toBe(200);
    const rows = listing.body as unknown as Array<{ id: string; revokedAt: string | null }>;
    const doomedRow = rows.find((row) => row.id === doomedKey.id);
    expect(doomedRow).toBeDefined();
    expect(doomedRow?.revokedAt).not.toBeNull();
    expect(new Date(doomedRow?.revokedAt as string).getTime()).toBeGreaterThan(0);
  });

  it('double-tapped identical reads answer identical inventories', async () => {
    const before = await auditCount();

    const raced = await Promise.all([
      api('GET', '/genapi/api-keys', undefined, readerKey.key),
      api('GET', '/genapi/api-keys', undefined, readerKey.key),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(200);
    expect(stripLastUsedAt(raced[0].body)).toEqual(stripLastUsedAt(raced[1].body));

    expect(await auditCount()).toBe(before);
  });

  it('race: keyed inventory read against a JWT key create', async () => {
    const before = await auditCount();
    const beforeCount = await prisma.apiKey.count({ where: { organizationId } });

    const raced = await Promise.all([
      api('GET', '/genapi/api-keys', undefined, readerKey.key),
      api(
        'POST',
        '/organizations/' + organizationId + '/api-keys',
        { name: 'Raced Key', scopes: ['READ_PROJECTS'] },
        hank.tokens.accessToken,
      ),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(201);

    const snapshot = stripLastUsedAt(raced[0].body);
    expect([beforeCount, beforeCount + 1]).toContain(snapshot.length);
    const snapshotIds = snapshot.map((row) => row.id as string);
    expect(new Set(snapshotIds).size).toBe(snapshotIds.length);

    const keyed = await api('GET', '/genapi/api-keys', undefined, readerKey.key);
    expect(keyed.status).toBe(200);
    const jwt = await api(
      'GET',
      '/organizations/' + organizationId + '/api-keys',
      undefined,
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(200);
    expect(stripLastUsedAt(keyed.body)).toEqual(stripLastUsedAt(jwt.body));
    const after = keyed.body as unknown as Array<{ id: string; name: string }>;
    expect(after.length).toBe(beforeCount + 1);
    expect(after.find((row) => row.name === 'Raced Key')).toBeDefined();

    expect(await auditCount()).toBe(before + 1);
  });

  it('refuses wrong-scope keys with one identical message and zero side effects', async () => {
    const before = await auditCount();

    const scopeMessages = new Set<string>();
    for (const wrongKey of [projectWriterKey, appWriterKey]) {
      const refused = await api('GET', '/genapi/api-keys', undefined, wrongKey.key);
      expect(refused.status).toBe(403);
      scopeMessages.add((refused.body as { message: string }).message);
    }
    expect(scopeMessages.size).toBe(1);
    expect(Array.from(scopeMessages)[0]).toBe('The API key does not grant the required scope.');

    expect(await auditCount()).toBe(before);
  });

  it('tenant-bounds the inventory to the key organization', async () => {
    const before = await auditCount();

    const irisListing = await api('GET', '/genapi/api-keys', undefined, irisReaderKey.key);
    expect(irisListing.status).toBe(200);
    const irisRows = irisListing.body as unknown as Array<{ id: string }>;
    expect(irisRows.length).toBe(1);
    expect(irisRows[0].id).toBe(irisReaderKey.id);

    const hankListing = await api('GET', '/genapi/api-keys', undefined, readerKey.key);
    expect(hankListing.status).toBe(200);
    const hankIds = new Set(
      (hankListing.body as unknown as Array<{ id: string }>).map((row) => row.id),
    );
    const irisIds = new Set(irisRows.map((row) => row.id));
    expect(hankIds.has(irisReaderKey.id)).toBe(false);
    for (const id of hankIds) {
      expect(irisIds.has(id)).toBe(false);
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

    const revokedRead = await api('GET', '/genapi/api-keys', undefined, revokedKey.key);
    expect(revokedRead.status).toBe(401);
    expect((revokedRead.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredRead = await api('GET', '/genapi/api-keys', undefined, shortLivedKey.key);
    expect(expiredRead.status).toBe(401);
    expect((expiredRead.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const anonymous = await api('GET', '/genapi/api-keys');
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { message: string }).message).toBe('A valid GENESIS API key is required.');
  });
});
