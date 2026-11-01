import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as http from 'node:http';
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
interface ReceivedRequest { method: string; url: string; }

/**
 * Keyed integration connection flows over the real app, the real CI
 * PostgreSQL, and a real local HTTP receiver. Grounded in the
 * GitHub list-installations-for-an-organization read behind the
 * organization administration read permission, the GitHub app
 * installation create, and the personal access token law that a
 * token never grants more access than its owner: keys are minted
 * only by organization admins, so a WRITE_ORGANIZATION key is an
 * admin-delegated connection write bounded to the key organization.
 * Connection tests perform REAL outbound HTTP against the receiver -
 * success, remote failure, and total unreachability are all
 * exercised - and every count and audit assertion is anchored in
 * prisma ground truth scoped by organizationId, because Jest
 * workers share the CI PostgreSQL.
 */
suite('GENESIS keyed integration connection flows (real app, real database, real receiver)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId = '';
  let foreignOrganizationId = '';
  let connKey: KeyContext;
  let readerKey: KeyContext;
  let scopedOutKey: KeyContext;
  let shortLivedKey: KeyContext;
  let revokedKey: KeyContext;
  let irisKey: KeyContext;
  let receiver: http.Server;
  let receiverUrl = '';
  let respondWithStatus = 200;
  const received: ReceivedRequest[] = [];
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);
  const password = 'gcf-connection-flows-password-123';

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
    const email = 'genesis-conn-' + name + '-' + runId + '@example.com';
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

  const keyedCreateConnection = (connectorId: string, name: string, credentials: Record<string, string>, key: string) =>
    api('POST', '/genapi/connections', { connectorId, name, credentials }, key);

  const sortedStatuses = (responses: ApiResponse[]) =>
    responses.map((response) => response.status).sort((a, b) => a - b);

  const receiverHits = () => received.filter((entry) => entry.method === 'GET' && entry.url.indexOf('/connection-test') !== -1).length;

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

    const server = app.getHttpServer() as http.Server;
    const address = server.address() as { port: number };
    baseUrl = 'http://127.0.0.1:' + address.port + '/api/v1';
    prisma = app.get(PrismaService);

    receiver = http.createServer((req, res) => {
      received.push({ method: req.method ?? '', url: req.url ?? '' });
      res.statusCode = respondWithStatus;
      res.end('received');
    });
    await new Promise<void>((resolve) => {
      receiver.listen(0, '127.0.0.1', () => resolve());
    });
    receiverUrl = 'http://127.0.0.1:' + (receiver.address() as { port: number }).port;
  });

  afterAll(async () => {
    if (receiver) {
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
    const orgIds = [organizationId, foreignOrganizationId].filter((id) => id !== '');
    if (orgIds.length > 0) {
      await prisma.auditEvent.deleteMany({ where: { organizationId: { in: orgIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('seeds two organizations and a key rack', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;

    connKey = await createKey(hank.tokens.accessToken, organizationId, 'Connection Manager', ['READ_ORGANIZATION', 'WRITE_ORGANIZATION']);
    readerKey = await createKey(hank.tokens.accessToken, organizationId, 'Connection Reader', ['READ_ORGANIZATION']);
    scopedOutKey = await createKey(hank.tokens.accessToken, organizationId, 'App Only', ['READ_APPLICATIONS']);
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Short Lived',
      ['WRITE_ORGANIZATION'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(hank.tokens.accessToken, organizationId, 'Revoked', ['WRITE_ORGANIZATION']);
    irisKey = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Iris Manager', ['READ_ORGANIZATION', 'WRITE_ORGANIZATION']);
  });

  it('offers the keyed connector catalog with exact JWT parity and no audit rows', async () => {
    const before = await auditCount(organizationId);

    const keyed = await api('GET', '/genapi/connectors', undefined, connKey.key);
    expect(keyed.status).toBe(200);
    const jwt = await api(
      'GET',
      '/organizations/' + organizationId + '/integrations/connectors',
      undefined,
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(200);
    expect(keyed.body).toEqual(jwt.body);

    const connectors = keyed.body as unknown as Array<{
      id: string;
      label: string;
      requiredCredentials: string[];
      testable: boolean;
    }>;
    expect(connectors.length).toBe(7);
    expect(new Set(connectors.map((entry) => entry.id)).size).toBe(7);
    connectors.forEach((entry) => {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.requiredCredentials.length).toBeGreaterThan(0);
      expect(entry.testable).toBe(true);
    });

    const refused = await api('GET', '/genapi/connectors', undefined, scopedOutKey.key);
    expect(refused.status).toBe(403);
    expect((refused.body as { message: string }).message).toBe('The API key does not grant the required scope.');

    expect(await auditCount(organizationId)).toBe(before);
  });

  it('lists connections with exact JWT parity and an honest empty start', async () => {
    const before = await auditCount(organizationId);

    const keyed = await api('GET', '/genapi/connections', undefined, connKey.key);
    expect(keyed.status).toBe(200);
    expect(Array.isArray(keyed.body)).toBe(true);
    expect((keyed.body as unknown as unknown[]).length).toBe(0);

    const jwt = await api(
      'GET',
      '/organizations/' + organizationId + '/integrations/connections',
      undefined,
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(200);
    expect(jwt.body).toEqual(keyed.body);

    expect(await auditCount(organizationId)).toBe(before);
  });

  it('creates a keyed connection that never echoes credential values', async () => {
    const before = await auditCount(organizationId);

    const secretValue = 'ghp_super_secret_token_value_7c31d9';
    const created = await keyedCreateConnection('github', 'github-prod', { accessToken: secretValue }, connKey.key);
    expect(created.status).toBe(201);
    const body = created.body as unknown as {
      id: string;
      organizationId: string;
      connectorId: string;
      name: string;
      status: string;
      credentialShape: Record<string, number>;
    };
    expect(body.connectorId).toBe('github');
    expect(body.name).toBe('github-prod');
    expect(body.status).toBe('UNVERIFIED');
    expect(body.organizationId).toBe(organizationId);
    expect(body.credentialShape.accessToken).toBe(secretValue.length);
    const serialized = JSON.stringify(created.body);
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain('credentials');

    expect(await auditCount(organizationId)).toBe(before + 1);
  });

  it('attributes keyed writes to the acting key and JWT writes to the user', async () => {
    const before = await auditCount(organizationId);

    const keyed = await keyedCreateConnection('gitlab', 'gitlab-keyed', { accessToken: 'glpat-keyed-value-1' }, connKey.key);
    expect(keyed.status).toBe(201);
    const keyedConnection = keyed.body as unknown as { id: string };

    const jwt = await api(
      'POST',
      '/organizations/' + organizationId + '/integrations/connections',
      { connectorId: 'gitlab', name: 'gitlab-jwt', credentials: { accessToken: 'glpat-jwt-value-1' } },
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(201);
    const jwtConnection = jwt.body as unknown as { id: string };

    const keyedAudit = await prisma.auditEvent.findFirst({
      where: { organizationId, action: 'integration.connection.create', resourceId: keyedConnection.id },
    });
    expect(keyedAudit).not.toBeNull();
    expect(keyedAudit!.actorUserId).toBe(hank.userId);
    const keyedMetadata = keyedAudit!.metadata as Record<string, unknown>;
    expect(keyedMetadata.via).toBe('genapi');
    expect(keyedMetadata.apiKeyId).toBe(connKey.id);
    expect(keyedMetadata.connectorId).toBe('gitlab');
    expect(keyedMetadata.name).toBe('gitlab-keyed');

    const jwtAudit = await prisma.auditEvent.findFirst({
      where: { organizationId, action: 'integration.connection.create', resourceId: jwtConnection.id },
    });
    expect(jwtAudit).not.toBeNull();
    expect(jwtAudit!.actorUserId).toBe(hank.userId);
    const jwtMetadata = jwtAudit!.metadata as Record<string, unknown>;
    expect(jwtMetadata.via).toBeUndefined();

    expect(await prisma.auditEvent.count({ where: { resourceId: keyedConnection.id } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { resourceId: jwtConnection.id } })).toBe(1);
    expect(await auditCount(organizationId)).toBe(before + 2);
  });

  it('tests keyed connections with real outbound HTTP and records honest outcomes', async () => {
    const before = await auditCount(organizationId);

    const ok = await keyedCreateConnection('custom', 'custom-ok', { baseUrl: receiverUrl }, connKey.key);
    expect(ok.status).toBe(201);
    const okId = (ok.body as { id: string }).id;

    const hitsBefore = receiverHits();
    const tested = await api('POST', '/genapi/connections/' + okId + '/test', {}, connKey.key);
    expect(tested.status).toBe(201);
    const okBody = tested.body as unknown as { status: string; lastTestStatus: string; lastTestDetail: string };
    expect(okBody.status).toBe('CONNECTED');
    expect(okBody.lastTestStatus).toBe('succeeded');
    expect(okBody.lastTestDetail).toContain('HTTP 200');
    expect(receiverHits()).toBe(hitsBefore + 1);

    const keyedTestAudit = await prisma.auditEvent.findFirst({
      where: { organizationId, action: 'integration.connection.test', resourceId: okId },
    });
    expect(keyedTestAudit).not.toBeNull();
    expect((keyedTestAudit!.metadata as Record<string, unknown>).via).toBe('genapi');

    const dead = await keyedCreateConnection('custom', 'custom-dead', { baseUrl: 'http://127.0.0.1:1/' }, connKey.key);
    const deadId = (dead.body as { id: string }).id;
    const unreachable = await api('POST', '/genapi/connections/' + deadId + '/test', {}, connKey.key);
    expect(unreachable.status).toBe(201);
    const deadBody = unreachable.body as unknown as { status: string; lastTestStatus: string; lastTestDetail: string };
    expect(deadBody.status).toBe('FAILED');
    expect(deadBody.lastTestStatus).toBe('unreachable');
    expect(deadBody.lastTestDetail.length).toBeGreaterThan(0);

    respondWithStatus = 500;
    const failing = await keyedCreateConnection('custom', 'custom-fail', { baseUrl: receiverUrl }, connKey.key);
    const failId = (failing.body as { id: string }).id;
    const failed = await api('POST', '/genapi/connections/' + failId + '/test', {}, connKey.key);
    expect(failed.status).toBe(201);
    const failBody = failed.body as unknown as { status: string; lastTestStatus: string; lastTestDetail: string };
    expect(failBody.status).toBe('FAILED');
    expect(failBody.lastTestStatus).toBe('failed');
    expect(failBody.lastTestDetail).toContain('HTTP 500');
    respondWithStatus = 200;

    expect(await auditCount(organizationId)).toBe(before + 6);
  });

  it('tenant-bounds the keyed surface behind one uniform 404', async () => {
    const hankList = await api('GET', '/genapi/connections', undefined, connKey.key);
    expect(hankList.status).toBe(200);
    const hankIds = (hankList.body as unknown as Array<{ id: string }>).map((row) => row.id);

    const irisOwn = await keyedCreateConnection('notion', 'iris-notion', { accessToken: 'secret_iris_notion_value' }, irisKey.key);
    expect(irisOwn.status).toBe(201);
    const irisList = await api('GET', '/genapi/connections', undefined, irisKey.key);
    expect(irisList.status).toBe(200);
    const irisIds = (irisList.body as unknown as Array<{ id: string }>).map((row) => row.id);
    expect(irisIds).not.toEqual(expect.arrayContaining(hankIds));
    expect(irisIds.length).toBe(1);

    const beforeHank = await auditCount(organizationId);
    const beforeIris = await auditCount(foreignOrganizationId);

    const foreignTest = await api('POST', '/genapi/connections/' + hankIds[0] + '/test', {}, irisKey.key);
    expect(foreignTest.status).toBe(404);
    expect((foreignTest.body as { message: string }).message).toBe('Integration connection not found.');

    const foreignDelete = await api('POST', '/genapi/connections/' + hankIds[0] + '/delete', {}, irisKey.key);
    expect(foreignDelete.status).toBe(404);
    expect((foreignDelete.body as { message: string }).message).toBe('Integration connection not found.');

    const unknownTest = await api('POST', '/genapi/connections/unknown-' + runId + '/test', {}, connKey.key);
    expect(unknownTest.status).toBe(404);
    expect((unknownTest.body as { message: string }).message).toBe('Integration connection not found.');

    const unknownDelete = await api('POST', '/genapi/connections/unknown-' + runId + '/delete', {}, connKey.key);
    expect(unknownDelete.status).toBe(404);
    expect((unknownDelete.body as { message: string }).message).toBe('Integration connection not found.');

    expect(await prisma.integration.count({ where: { organizationId } })).toBe(hankIds.length);
    expect(await auditCount(organizationId)).toBe(beforeHank);
    expect(await auditCount(foreignOrganizationId)).toBe(beforeIris);
  });

  it('resolves create double-taps with exactly one winner on both race pairs', async () => {
    const before = await auditCount(organizationId);
    const rowsBefore = await prisma.integration.count({ where: { organizationId } });

    const keyedRace = await Promise.all([
      keyedCreateConnection('netlify', 'netlify-ci', { accessToken: 'nfp-race-value-1' }, connKey.key),
      keyedCreateConnection('netlify', 'netlify-ci', { accessToken: 'nfp-race-value-2' }, connKey.key),
    ]);
    expect(sortedStatuses(keyedRace)).toEqual([201, 409]);

    const mixedRace = await Promise.all([
      keyedCreateConnection('vercel', 'vercel-ci', { apiToken: 'vercel-race-value-1' }, connKey.key),
      api(
        'POST',
        '/organizations/' + organizationId + '/integrations/connections',
        { connectorId: 'vercel', name: 'vercel-ci', credentials: { apiToken: 'vercel-race-value-2' } },
        hank.tokens.accessToken,
      ),
    ]);
    expect(sortedStatuses(mixedRace)).toEqual([201, 409]);

    expect(await prisma.integration.count({ where: { organizationId } })).toBe(rowsBefore + 2);
    expect(await auditCount(organizationId)).toBe(before + 2);
  });

  it('resolves delete double-taps with exactly one winner and audit row', async () => {
    const created = await keyedCreateConnection('figma', 'figma-clean', { accessToken: 'figma-token-value-1', fileKey: 'figma-file-key-1' }, connKey.key);
    const id = (created.body as { id: string }).id;

    const before = await auditCount(organizationId);
    const raced = await Promise.all([
      api('POST', '/genapi/connections/' + id + '/delete', {}, connKey.key),
      api('POST', '/genapi/connections/' + id + '/delete', {}, connKey.key),
    ]);
    expect(sortedStatuses(raced)).toEqual([201, 404]);

    expect(await prisma.integration.count({ where: { id } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { organizationId, action: 'integration.connection.delete', resourceId: id } })).toBe(1);
    expect(await auditCount(organizationId)).toBe(before + 1);

    const jwtCreated = await api(
      'POST',
      '/organizations/' + organizationId + '/integrations/connections',
      { connectorId: 'notion', name: 'notion-cross', credentials: { accessToken: 'notion-cross-value' } },
      hank.tokens.accessToken,
    );
    expect(jwtCreated.status).toBe(201);
    const jwtId = (jwtCreated.body as { id: string }).id;

    const keyedDelete = await api('POST', '/genapi/connections/' + jwtId + '/delete', {}, connKey.key);
    expect(keyedDelete.status).toBe(201);
    expect((keyedDelete.body as { deleted: boolean; connectionId: string })).toEqual({ deleted: true, connectionId: jwtId });

    const keyCreated = await keyedCreateConnection('notion', 'notion-cross-keyed', { accessToken: 'notion-cross-keyed-value' }, connKey.key);
    const keyId = (keyCreated.body as { id: string }).id;
    const jwtDelete = await api(
      'DELETE',
      '/organizations/' + organizationId + '/integrations/connections/' + keyId,
      undefined,
      hank.tokens.accessToken,
    );
    expect(jwtDelete.status).toBe(200);
    expect(await prisma.integration.count({ where: { id: keyId } })).toBe(0);
  });

  it('refuses wrong scopes and malformed bodies with zero side effects', async () => {
    const rowsBefore = await prisma.integration.count({ where: { organizationId } });
    const before = await auditCount(organizationId);

    const scopeRefused = await keyedCreateConnection('github', 'no-scope', { accessToken: 'ghp_value_1' }, readerKey.key);
    expect(scopeRefused.status).toBe(403);
    expect((scopeRefused.body as { message: string }).message).toBe('The API key does not grant the required scope.');

    const listRefused = await api('GET', '/genapi/connections', undefined, scopedOutKey.key);
    expect(listRefused.status).toBe(403);
    expect((listRefused.body as { message: string }).message).toBe('The API key does not grant the required scope.');

    const unknownConnector = await keyedCreateConnection('shopify', 'shop', { token: 'x' }, connKey.key);
    expect(unknownConnector.status).toBe(400);

    const missingCredential = await keyedCreateConnection('github', 'no-token', {}, connKey.key);
    expect(missingCredential.status).toBe(400);

    const unknownField = await keyedCreateConnection('github', 'extra', { accessToken: 'ghp_value_2', webhookSecret: 'sneaky' }, connKey.key);
    expect(unknownField.status).toBe(400);

    const emptyName = await keyedCreateConnection('github', '   ', { accessToken: 'ghp_value_3' }, connKey.key);
    expect(emptyName.status).toBe(400);

    const rogueField = await api('POST', '/genapi/connections', { connectorId: 'github', name: 'rogue', credentials: { accessToken: 'ghp_value_4' }, rogue: 'x' }, connKey.key);
    expect(rogueField.status).toBe(400);

    expect(await prisma.integration.count({ where: { organizationId } })).toBe(rowsBefore);
    expect(await auditCount(organizationId)).toBe(before);
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect([200, 201]).toContain(revoke.status);

    const revokedCall = await keyedCreateConnection('github', 'revoked-conn', { accessToken: 'ghp_value_5' }, revokedKey.key);
    expect(revokedCall.status).toBe(401);
    expect((revokedCall.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredCall = await keyedCreateConnection('github', 'expired-conn', { accessToken: 'ghp_value_6' }, shortLivedKey.key);
    expect(expiredCall.status).toBe(401);
    expect((expiredCall.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const anonymous = await api('POST', '/genapi/connections', {
      connectorId: 'github',
      name: 'anonymous-conn',
      credentials: { accessToken: 'ghp_value_7' },
    });
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { message: string }).message).toBe('A valid GENESIS API key is required.');
  });
});
