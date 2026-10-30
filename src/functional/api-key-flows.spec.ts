import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
// Small per-key rate limit so the 429 behavior is testable in this suite.
process.env.GENESIS_API_KEY_RATE_LIMIT = process.env.GENESIS_API_KEY_RATE_LIMIT ?? '5';

const hasDatabase = typeof process.env.DATABASE_URL === 'string'
  && process.env.DATABASE_URL.startsWith('postgres');
const hasJwtSecret = typeof process.env.JWT_ACCESS_SECRET === 'string'
  && process.env.JWT_ACCESS_SECRET.length >= 32;
const suite = hasDatabase && hasJwtSecret ? describe : describe.skip;

interface TokenPair { accessToken: string; refreshToken: string; }

interface UserContext { email: string; tokens: TokenPair; userId: string; }

interface ApiResponse { status: number; body: Record<string, unknown>; }

const ALL_SCOPES = ['READ_ORGANIZATION', 'READ_PROJECTS', 'READ_APPLICATIONS'];

suite('GENESIS API key product flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId: string;
  let workspaceId: string;
  let projectId: string;
  let applicationId: string;
  let fullKey: string;
  let fullKeyId: string;
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

  const registerUser = async (name: string): Promise<UserContext> => {
    const email = `genesis-key-${name}-${runId}@example.com`;
    const response = await api('POST', '/auth/register', {
      email,
      password: 'api-key-test-password-123',
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

  const createKey = async (token: string, name: string, scopes: string[], expiresAt?: string) =>
    api(
      'POST',
      '/organizations/' + organizationId + '/api-keys',
      expiresAt === undefined ? { name, scopes } : { name, scopes, expiresAt },
      token,
    );

  const genapi = (path: string, key: string | undefined) =>
    api('GET', '/genapi/' + path, undefined, key);

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
  });

  afterAll(async () => {
    const { PrismaService } = await import('../database/prisma.service');
    const prisma = app.get(PrismaService);
    if (createdUserIds.length > 0) {
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('registers users and seeds an organization, project, and application', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const organizations = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(organizations.status).toBe(200);
    organizationId = (organizations.body as unknown as Array<{ id: string }>)[0].id;

    const workspaces = await api('GET', '/workspaces', undefined, hank.tokens.accessToken);
    expect(workspaces.status).toBe(200);
    workspaceId = (workspaces.body as unknown as Array<{ id: string }>)[0].id;

    const project = await api(
      'POST',
      '/workspaces/' + workspaceId + '/projects',
      { name: 'Keyed API Project' },
      hank.tokens.accessToken,
    );
    expect(project.status).toBe(201);
    projectId = (project.body as { id: string }).id;

    const application = await api(
      'POST',
      '/projects/' + projectId + '/applications',
      { name: 'Keyed API App' },
      hank.tokens.accessToken,
    );
    expect(application.status).toBe(201);
    applicationId = (application.body as { id: string }).id;
  });

  it('creates a full-scope key and reveals the plaintext exactly once', async () => {
    const created = await createKey(hank.tokens.accessToken, 'ci-pipeline', ALL_SCOPES);
    expect(created.status).toBe(201);
    const body = created.body as {
      id: string;
      key: string;
      displayHint: string;
      scopes: string[];
      revokedAt: string | null;
    };
    expect(body.key).toMatch(/^gn_live_[A-Za-z0-9_-]{43}$/);
    expect(body.displayHint).toContain('…');
    expect(body.displayHint.length).toBeLessThan(body.key.length);
    expect(body.scopes).toEqual(ALL_SCOPES);
    expect(body.revokedAt).toBeNull();
    expect(created.body.hashedKey).toBeUndefined();
    fullKey = body.key;
    fullKeyId = body.id;
  });

  it('refuses invalid key creations with named product behavior', async () => {
    const unknownScope = await createKey(hank.tokens.accessToken, 'bad-scope', ['WRITE_EVERYTHING']);
    expect(unknownScope.status).toBe(400);
    const emptyScopes = await createKey(hank.tokens.accessToken, 'empty-scopes', []);
    expect(emptyScopes.status).toBe(400);
    const longName = await createKey(hank.tokens.accessToken, 'a'.repeat(101), ['READ_PROJECTS']);
    expect(longName.status).toBe(400);
    const pastExpiry = await createKey(
      hank.tokens.accessToken,
      'expired-at-birth',
      ['READ_PROJECTS'],
      '2020-01-01T00:00:00.000Z',
    );
    expect(pastExpiry.status).toBe(400);
  });

  it('lists keys masked - never the plaintext or the hash', async () => {
    const list = await api(
      'GET',
      '/organizations/' + organizationId + '/api-keys',
      undefined,
      hank.tokens.accessToken,
    );
    expect(list.status).toBe(200);
    const keys = list.body as unknown as Array<Record<string, unknown>>;
    expect(keys.length).toBeGreaterThanOrEqual(1);
    const serialized = JSON.stringify(keys);
    expect(serialized).not.toContain(fullKey);
    expect(serialized).not.toContain('hashedKey');
    const mine = keys.find((key) => key.id === fullKeyId) as { displayHint: string };
    expect(mine.displayHint).toContain('gn_live_');
  });

  it('authenticates the key against the keyed GENESIS API and reads tenant data', async () => {
    const me = await genapi('me', fullKey);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      organization: { id: organizationId },
      key: { scopes: ALL_SCOPES },
    });

    const projects = await genapi('projects', fullKey);
    expect(projects.status).toBe(200);
    const projectList = projects.body as unknown as Array<{ id: string }>
    expect(projectList.some((entry) => entry.id === projectId)).toBe(true);

    const applications = await genapi('applications', fullKey);
    expect(applications.status).toBe(200);
    const applicationList = applications.body as unknown as Array<{ id: string }>
    expect(applicationList.some((entry) => entry.id === applicationId)).toBe(true);
  });

  it('records last-used after authentication', async () => {
    const list = await api(
      'GET',
      '/organizations/' + organizationId + '/api-keys',
      undefined,
      hank.tokens.accessToken,
    );
    const keys = list.body as unknown as Array<{ id: string; lastUsedAt: string | null }>
    expect(keys.find((key) => key.id === fullKeyId)?.lastUsedAt).not.toBeNull();
  });

  it('serves two simultaneous key-authenticated requests without corruption', async () => {
    const raced = await Promise.all([genapi('me', fullKey), genapi('me', fullKey)]);
    expect(raced.every((response) => response.status === 200)).toBe(true);
  });

  it('enforces scopes per endpoint: a projects-only key cannot read applications', async () => {
    const created = await createKey(hank.tokens.accessToken, 'projects-only', ['READ_PROJECTS']);
    expect(created.status).toBe(201);
    const limitedKey = (created.body as { key: string }).key;

    const projects = await genapi('projects', limitedKey);
    expect(projects.status).toBe(200);
    const applications = await genapi('applications', limitedKey);
    expect(applications.status).toBe(403);
  });

  it('rejects malformed, missing, and unknown credentials with a uniform 401', async () => {
    expect((await genapi('me', undefined)).status).toBe(401);
    expect((await genapi('me', 'gn_live_short')).status).toBe(401);
    expect((await genapi('me', 'sk_live_totally-wrong-key-1234567890')).status).toBe(401);
    expect((
      await genapi('me', 'gn_live_' + 'a'.repeat(43))
    ).status).toBe(401);
  });

  it('honors expiry: a future-dated key works, a key cannot be born expired', async () => {
    const created = await createKey(
      hank.tokens.accessToken,
      'expiring',
      ['READ_ORGANIZATION'],
      '2030-01-01T00:00:00.000Z',
    );
    expect(created.status).toBe(201);
    const expiringKey = (created.body as { key: string }).key;
    expect((await genapi('me', expiringKey)).status).toBe(200);
  });

  it('refuses non-admins and outsiders from managing keys', async () => {
    const outsider = await createKey(iris.tokens.accessToken, 'not-yours', ['READ_PROJECTS']);
    expect(outsider.status).toBe(404);
    const outsiderList = await api(
      'GET',
      '/organizations/' + organizationId + '/api-keys',
      undefined,
      iris.tokens.accessToken,
    );
    expect(outsiderList.status).toBe(404);
  });

  it('revokes a key: it stops working instantly and the double-tap is refused', async () => {
    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + fullKeyId + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect(revoke.status).toBe(201);

    expect((await genapi('me', fullKey)).status).toBe(401);

    const revokeAgain = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + fullKeyId + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect(revokeAgain.status).toBe(404);

    const revokeUnknown = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/does-not-exist/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect(revokeUnknown.status).toBe(404);
  });

  it('resolves two simultaneous revocations of the same key with exactly one winner', async () => {
    const created = await createKey(hank.tokens.accessToken, 'race-revoke', ['READ_ORGANIZATION']);
    expect(created.status).toBe(201);
    const keyId = (created.body as { id: string }).id;
    const key = (created.body as { key: string }).key;
    expect((await genapi('me', key)).status).toBe(200);

    const revoke = () =>
      api(
        'POST',
        '/organizations/' + organizationId + '/api-keys/' + keyId + '/revoke',
        {},
        hank.tokens.accessToken,
      );
    const raced = await Promise.all([revoke(), revoke()]);
    expect(raced.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 404]);
    expect((await genapi('me', key)).status).toBe(401);
  });

  it('enforces the per-key rate limit after the configured window budget', async () => {
    const created = await createKey(hank.tokens.accessToken, 'rate-limited', ['READ_ORGANIZATION']);
    expect(created.status).toBe(201);
    const key = (created.body as { key: string }).key;

    for (let i = 0; i < 5; i += 1) {
      expect((await genapi('me', key)).status).toBe(200);
    }
    expect((await genapi('me', key)).status).toBe(429);
  });

  it('audits every key lifecycle action', async () => {
    const trail = await api(
      'GET',
      '/organizations/' + organizationId + '/audit-events',
      undefined,
      hank.tokens.accessToken,
    );
    expect(trail.status).toBe(200);
    const events = trail.body as unknown as Array<{ action: string }>
    expect(events.some((event) => event.action === 'apikey.create')).toBe(true);
    expect(events.some((event) => event.action === 'apikey.revoke')).toBe(true);
  });
});
