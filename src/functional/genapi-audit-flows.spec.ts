import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditOutcome } from '@prisma/client';
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
interface AuditRow {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  actor: { email: string } | null;
}
interface ApiResponse { status: number; body: Record<string, unknown>; }

/**
 * Key-authenticated organization audit trail against the real app and
 * the real CI PostgreSQL. Grounded in the GitHub audit log REST
 * surface: reading audit data is a deliberately gated read behind a
 * dedicated read permission, results come back newest first, and the
 * response is a flat array of entries. Stripe keeps its audit logs
 * dashboard-only; GENESIS follows the GitHub model instead, because
 * the genapi surface exists precisely for machine access to
 * organization data. The key surface mirrors the JWT admin listing
 * exactly so the two surfaces can never drift apart, the key is the
 * tenant bound (there is no path parameter to probe), and reads never
 * write audit rows.
 */
suite('GENESIS genapi audit trail flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId: string;
  let foreignOrganizationId: string;
  let applicationId: string;
  let keyedCheckpointId: string;
  let readerKey: KeyContext;
  let appKey: KeyContext;
  let writerKey: KeyContext;
  let shortLivedKey: KeyContext;
  let revokedKey: KeyContext;
  let irisReaderKey: KeyContext;
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
    const email = 'genesis-audit-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'audit-trail-password-123',
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

  const auditRead = (key: KeyContext) => api('GET', '/genapi/audit-events', undefined, key.key);

  const auditRows = (body: Record<string, unknown>) => body as unknown as AuditRow[];

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

  it('seeds two organizations, an application, and scoped keys', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;
    expect(foreignOrganizationId).not.toBe(organizationId);

    const workspaces = await api('GET', '/workspaces', undefined, hank.tokens.accessToken);
    expect(workspaces.status).toBe(200);
    const workspaceId = (workspaces.body as unknown as Array<{ id: string }>)[0].id;
    const project = await api(
      'POST',
      '/workspaces/' + workspaceId + '/projects',
      { name: 'Audit Trail Project ' + runId },
      hank.tokens.accessToken,
    );
    expect(project.status).toBe(201);
    const projectId = (project.body as { id: string }).id;
    const application = await api(
      'POST',
      '/projects/' + projectId + '/applications',
      { name: 'Audit Trail App ' + runId },
      hank.tokens.accessToken,
    );
    expect(application.status).toBe(201);
    applicationId = (application.body as { id: string }).id;

    readerKey = await createKey(hank.tokens.accessToken, organizationId, 'Audit Reader', ['READ_ORGANIZATION']);
    appKey = await createKey(hank.tokens.accessToken, organizationId, 'Audit App Reader', ['READ_APPLICATIONS']);
    writerKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Audit Writer',
      ['READ_APPLICATIONS', 'WRITE_APPLICATIONS'],
    );
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Audit Short Lived',
      ['READ_ORGANIZATION'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(hank.tokens.accessToken, organizationId, 'Audit Revoked', ['READ_ORGANIZATION']);
    irisReaderKey = await createKey(
      iris.tokens.accessToken,
      foreignOrganizationId,
      'Foreign Reader',
      ['READ_ORGANIZATION'],
    );
  });

  it('mirrors the JWT admin listing exactly', async () => {
    const keyed = await auditRead(readerKey);
    expect(keyed.status).toBe(200);
    const jwt = await api(
      'GET',
      '/organizations/' + organizationId + '/audit-events',
      undefined,
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(200);
    expect(auditRows(keyed.body)).toEqual(auditRows(jwt.body));
    expect(auditRows(keyed.body).length).toBeGreaterThan(0);
  });

  it('returns the full audit shape newest first', async () => {
    const keyed = await auditRead(readerKey);
    expect(keyed.status).toBe(200);
    const rows = auditRows(keyed.body);
    for (let idx = 1; idx < rows.length; idx += 1) {
      expect(new Date(rows[idx - 1].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(rows[idx].createdAt).getTime(),
      );
    }
    for (const row of rows) {
      expect(row.id).toBeTruthy();
      expect(row.action).toBeTruthy();
      expect(row.resourceType).toBeTruthy();
      expect(['SUCCESS', 'DENIED', 'FAILURE']).toContain(row.outcome);
      expect(row.createdAt).toBeTruthy();
    }
    const registration = rows.find((row) => row.action === 'auth.register');
    expect(registration).toBeDefined();
    expect(registration?.actor?.email).toBe(hank.email);

    const keyCreation = rows.find(
      (row) => row.action === 'apikey.create' && row.metadata?.name === 'Audit Reader',
    );
    expect(keyCreation).toBeDefined();
    expect(keyCreation?.actor?.email).toBe(hank.email);
  });

  it('shows keyed actions attributed to their acting key', async () => {
    const checkpoint = await api(
      'POST',
      '/genapi/applications/' + applicationId + '/checkpoints',
      { label: 'Keyed audit checkpoint.' },
      writerKey.key,
    );
    expect(checkpoint.status).toBe(201);
    keyedCheckpointId = (checkpoint.body as { id: string }).id;

    const keyed = await auditRead(readerKey);
    expect(keyed.status).toBe(200);
    const matches = auditRows(keyed.body).filter(
      (row) => row.action === 'application.checkpoint.create' && row.resourceId === keyedCheckpointId,
    );
    expect(matches.length).toBe(1);
    expect(matches[0].metadata?.via).toBe('genapi');
    expect(matches[0].metadata?.apiKeyId).toBe(writerKey.id);
    expect(matches[0].actor?.email).toBe(hank.email);
  });

  it('never writes audit rows for reads or refusals', async () => {
    const before = await auditCount();

    const read = await auditRead(readerKey);
    expect(read.status).toBe(200);

    const refused = await auditRead(appKey);
    expect(refused.status).toBe(403);
    expect((refused.body as { message: string }).message).toBe(
      'The API key does not grant the required scope.',
    );

    const unauthenticated = await api('GET', '/genapi/audit-events');
    expect(unauthenticated.status).toBe(401);

    const garbage = await api(
      'GET',
      '/genapi/audit-events',
      undefined,
      'gn_live_this-key-does-not-exist-anywhere-1234567890',
    );
    expect(garbage.status).toBe(401);

    expect(await auditCount()).toBe(before);
  });

  it('tenant-bounds each key to its own organization trail', async () => {
    const hankRead = await auditRead(readerKey);
    expect(hankRead.status).toBe(200);
    const irisRead = await auditRead(irisReaderKey);
    expect(irisRead.status).toBe(200);

    const hankIds = new Set(auditRows(hankRead.body).map((row) => row.id));
    const irisIds = new Set(auditRows(irisRead.body).map((row) => row.id));
    expect(hankIds.size).toBeGreaterThan(0);
    expect(irisIds.size).toBeGreaterThan(0);
    for (const id of irisIds) {
      expect(hankIds.has(id)).toBe(false);
    }

    const irisRows = auditRows(irisRead.body);
    const irisRegistration = irisRows.find((row) => row.action === 'auth.register');
    expect(irisRegistration?.actor?.email).toBe(iris.email);
    const irisKeyCreation = irisRows.find(
      (row) => row.action === 'apikey.create' && row.metadata?.name === 'Foreign Reader',
    );
    expect(irisKeyCreation).toBeDefined();
    expect(irisKeyCreation?.actor?.email).toBe(iris.email);
    const hankEmails = auditRows(hankRead.body)
      .map((row) => row.actor?.email)
      .filter((email): email is string => email !== undefined);
    expect(hankEmails).not.toContain(iris.email);

    // The keyed checkpoint row stays invisible to the foreign organization.
    const hankCheckpointVisible = auditRows(hankRead.body).some(
      (row) => row.resourceId === keyedCheckpointId,
    );
    expect(hankCheckpointVisible).toBe(true);
    const irisCheckpointVisible = irisRows.some(
      (row) => row.resourceId === keyedCheckpointId,
    );
    expect(irisCheckpointVisible).toBe(false);
  });

  it('answers a double-tapped audit read with identical clean listings', async () => {
    const raced = await Promise.all([auditRead(readerKey), auditRead(readerKey)]);
    expect(raced.map((response) => response.status).sort()).toEqual([200, 200]);
    expect(raced[0].body).toEqual(raced[1].body);
  });

  it('stays clean when a keyed audit read races a keyed checkpoint create', async () => {
    const raced = await Promise.all([
      auditRead(readerKey),
      api(
        'POST',
        '/genapi/applications/' + applicationId + '/checkpoints',
        { label: 'Raced audit checkpoint.' },
        writerKey.key,
      ),
    ]);
    expect(raced[0].status).toBe(200);
    expect(Array.isArray(raced[0].body)).toBe(true);
    expect(raced[1].status).toBe(201);
    const racedCheckpointId = (raced[1].body as { id: string }).id;

    const audited = await prisma.auditEvent.count({
      where: {
        action: 'application.checkpoint.create',
        resourceId: racedCheckpointId,
        organizationId,
      },
    });
    expect(audited).toBe(1);

    const after = await auditRead(readerKey);
    expect(after.status).toBe(200);
    expect(
      auditRows(after.body).some((row) => row.resourceId === racedCheckpointId),
    ).toBe(true);
  });

  it('caps the listing at the newest fifty events on both surfaces', async () => {
    const now = Date.now();
    await prisma.auditEvent.createMany({
      data: Array.from({ length: 60 }, (_, idx) => ({
        actorUserId: null,
        organizationId,
        action: 'organization.member.add',
        resourceType: 'membership',
        resourceId: null,
        outcome: AuditOutcome.SUCCESS,
        metadata: { seeded: idx },
        createdAt: new Date(now - (60 - idx) * 1000),
      })),
    });

    const total = await prisma.auditEvent.count({ where: { organizationId } });
    expect(total).toBeGreaterThan(50);
    const groundTruth = await prisma.auditEvent.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true },
    });
    const truthIds = groundTruth.map((row) => row.id);

    const keyed = await auditRead(readerKey);
    expect(keyed.status).toBe(200);
    const keyedRows = auditRows(keyed.body);
    expect(keyedRows.length).toBe(50);
    expect(keyedRows.map((row) => row.id)).toEqual(truthIds);

    const jwt = await api(
      'GET',
      '/organizations/' + organizationId + '/audit-events',
      undefined,
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(200);
    expect(auditRows(jwt.body).map((row) => row.id)).toEqual(truthIds);
    expect(keyedRows).toEqual(auditRows(jwt.body));

    for (let idx = 1; idx < keyedRows.length; idx += 1) {
      expect(new Date(keyedRows[idx - 1].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(keyedRows[idx].createdAt).getTime(),
      );
    }
  });

  it('refuses keys without the organization read scope with one message', async () => {
    const messages = new Set<string>();
    for (const key of [appKey, writerKey]) {
      const refused = await auditRead(key);
      expect(refused.status).toBe(403);
      messages.add((refused.body as { message: string }).message);
    }
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('The API key does not grant the required scope.');
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect([200, 201]).toContain(revoke.status);

    const revokedRead = await auditRead(revokedKey);
    expect(revokedRead.status).toBe(401);
    expect((revokedRead.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredRead = await auditRead(shortLivedKey);
    expect(expiredRead.status).toBe(401);
    expect((expiredRead.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    const unauthenticated = await api('GET', '/genapi/audit-events');
    expect(unauthenticated.status).toBe(401);
    expect((unauthenticated.body as { message: string }).message).toBe(
      'A valid GENESIS API key is required.',
    );
  });
});
