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

/**
 * Connector expansion flows for Slack, Linear, and Stripe over the real
 * app, the real CI PostgreSQL, and a real local HTTP receiver. Grounded
 * in the market law for connection verification: Slack pins identity
 * with auth.test and answers HTTP 200 even when the token is bad, so a
 * JSON body that reports ok false is a failure no matter the status
 * line; Linear verifies personal API keys with the raw key and no
 * Bearer prefix; Stripe accepts Bearer auth on the cheap account read.
 * The ok false law is pinned deterministically against the local
 * receiver, the real providers answer over real outbound requests with
 * honestly recorded outcomes, and every count and audit assertion is
 * anchored in prisma ground truth scoped by organizationId, because
 * Jest workers share the CI PostgreSQL.
 */
suite('GENESIS connector expansion flows (real app, real database, real receiver)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let milo: UserContext;
  let tara: UserContext;
  let zed: UserContext;
  let organizationId = '';
  let connKey: KeyContext;
  let revokedKey: KeyContext;
  let receiver: http.Server;
  let receiverUrl = '';
  let respondBody = 'received';
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);
  const password = 'connector-expansion-password-123';

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
    const email = 'genesis-cec-' + name + '-' + runId + '@example.com';
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
  ): Promise<KeyContext> => {
    const response = await api(
      'POST',
      '/organizations/' + orgId + '/api-keys',
      { name, scopes },
      accessToken,
    );
    expect(response.status).toBe(201);
    const body = response.body as { id: string; key: string };
    expect(body.key).toMatch(/^gn_live_[A-Za-z0-9_-]{43}$/);
    return { id: body.id, key: body.key };
  };

  const auditCount = (orgId: string) => prisma.auditEvent.count({ where: { organizationId: orgId } });

  const createConnection = (token: string, connectorId: string, name: string, credentials: Record<string, string>) =>
    api(
      'POST',
      '/organizations/' + organizationId + '/integrations/connections',
      { connectorId, name, credentials },
      token,
    );

  const testConnection = (token: string, connectionId: string) =>
    api(
      'POST',
      '/organizations/' + organizationId + '/integrations/connections/' + connectionId + '/test',
      {},
      token,
    );

  const sortedStatuses = (responses: ApiResponse[]) =>
    responses.map((response) => response.status).sort((a, b) => a - b);

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
    const server = app.getHttpServer() as http.Server;
    const address = server.address() as { port: number };
    baseUrl = 'http://127.0.0.1:' + address.port + '/api/v1';
    prisma = app.get(PrismaService);

    receiver = http.createServer((req, res) => {
      res.statusCode = 200;
      res.end(respondBody);
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
    if (organizationId !== '') {
      await prisma.auditEvent.deleteMany({ where: { organizationId } });
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

  it('seeds an organization, a key rack, and a local receiver', async () => {
    milo = await registerUser('milo');
    tara = await registerUser('tara');
    zed = await registerUser('zed');

    const orgs = await api('GET', '/organizations', undefined, milo.tokens.accessToken);
    expect(orgs.status).toBe(200);
    organizationId = (orgs.body as unknown as Array<{ id: string }>)[0].id;

    const addTara = await api(
      'POST',
      '/organizations/' + organizationId + '/members',
      { email: tara.email, role: 'ADMIN' },
      milo.tokens.accessToken,
    );
    expect(addTara.status).toBe(201);

    connKey = await createKey(milo.tokens.accessToken, organizationId, 'Expansion Manager', ['READ_ORGANIZATION', 'WRITE_ORGANIZATION']);
    revokedKey = await createKey(milo.tokens.accessToken, organizationId, 'Expansion Revoked', ['WRITE_ORGANIZATION']);
  });

  it('offers the three new connectors with honest contracts on both surfaces', async () => {
    const before = await auditCount(organizationId);

    const jwt = await api(
      'GET',
      '/organizations/' + organizationId + '/integrations/connectors',
      undefined,
      milo.tokens.accessToken,
    );
    expect(jwt.status).toBe(200);
    const keyed = await api('GET', '/genapi/connectors', undefined, connKey.key);
    expect(keyed.status).toBe(200);
    expect(keyed.body).toEqual(jwt.body);

    const connectors = keyed.body as unknown as Array<{
      id: string;
      label: string;
      category: string;
      requiredCredentials: string[];
      optionalCredentials: string[];
      testable: boolean;
    }>;
    expect(connectors.length).toBe(10);

    const slack = connectors.find((entry) => entry.id === 'slack')!;
    expect(slack.label).toBe('Slack');
    expect(slack.category).toBe('MESSAGING');
    expect(slack.requiredCredentials).toEqual(['accessToken']);
    expect(slack.optionalCredentials).toEqual(['channelId']);
    expect(slack.testable).toBe(true);

    const linear = connectors.find((entry) => entry.id === 'linear')!;
    expect(linear.label).toBe('Linear');
    expect(linear.category).toBe('ISSUE_TRACKING');
    expect(linear.requiredCredentials).toEqual(['apiKey']);
    expect(linear.optionalCredentials).toEqual([]);
    expect(linear.testable).toBe(true);

    const stripe = connectors.find((entry) => entry.id === 'stripe')!;
    expect(stripe.label).toBe('Stripe');
    expect(stripe.category).toBe('PAYMENTS');
    expect(stripe.requiredCredentials).toEqual(['secretKey']);
    expect(stripe.optionalCredentials).toEqual([]);
    expect(stripe.testable).toBe(true);

    expect(await auditCount(organizationId)).toBe(before);
  });

  it('creates the three new connections without ever echoing credential values', async () => {
    const before = await auditCount(organizationId);

    const slackToken = 'xoxb-expansion-secret-token-1a2b3c';
    const slackCreated = await createConnection(milo.tokens.accessToken, 'slack', 'slack-alerts', { accessToken: slackToken, channelId: 'C0EXPANSION1' });
    expect(slackCreated.status).toBe(201);
    const slackBody = slackCreated.body as unknown as {
      connectorId: string;
      name: string;
      status: string;
      credentialShape: Record<string, number>;
    };
    expect(slackBody.connectorId).toBe('slack');
    expect(slackBody.status).toBe('UNVERIFIED');
    expect(slackBody.credentialShape.accessToken).toBe(slackToken.length);
    expect(slackBody.credentialShape.channelId).toBe('C0EXPANSION1'.length);
    expect(JSON.stringify(slackCreated.body)).not.toContain(slackToken);
    expect(await auditCount(organizationId)).toBe(before + 1);

    const linearKey = 'lin_api_expansion_secret_1a2b3c';
    const linearCreated = await createConnection(milo.tokens.accessToken, 'linear', 'linear-board', { apiKey: linearKey });
    expect(linearCreated.status).toBe(201);
    const linearBody = linearCreated.body as unknown as { credentialShape: Record<string, number> };
    expect(linearBody.credentialShape.apiKey).toBe(linearKey.length);
    expect(JSON.stringify(linearCreated.body)).not.toContain(linearKey);
    expect(await auditCount(organizationId)).toBe(before + 2);

    const stripeKey = 'sk_test_expansion_secret_1a2b3c';
    const stripeCreated = await createConnection(milo.tokens.accessToken, 'stripe', 'stripe-billing', { secretKey: stripeKey });
    expect(stripeCreated.status).toBe(201);
    const stripeBody = stripeCreated.body as unknown as { credentialShape: Record<string, number> };
    expect(stripeBody.credentialShape.secretKey).toBe(stripeKey.length);
    expect(JSON.stringify(stripeCreated.body)).not.toContain(stripeKey);
    expect(await auditCount(organizationId)).toBe(before + 3);

    const list = await api(
      'GET',
      '/organizations/' + organizationId + '/integrations/connections',
      undefined,
      milo.tokens.accessToken,
    );
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(slackToken);
    expect(JSON.stringify(list.body)).not.toContain(linearKey);
    expect(JSON.stringify(list.body)).not.toContain(stripeKey);
  });

  it('refuses malformed new-connector requests with clean errors and zero side effects', async () => {
    const rowsBefore = await prisma.integration.count({ where: { organizationId } });
    const before = await auditCount(organizationId);

    const slackMissing = await createConnection(milo.tokens.accessToken, 'slack', 'slack-no-token', { channelId: 'C0EXPANSION2' });
    expect(slackMissing.status).toBe(400);

    const slackUnknown = await createConnection(milo.tokens.accessToken, 'slack', 'slack-extra', { accessToken: 'xoxb-value-1', webhookUrl: 'https://hooks.example' });
    expect(slackUnknown.status).toBe(400);

    const linearEmpty = await createConnection(milo.tokens.accessToken, 'linear', 'linear-blank', { apiKey: '   ' });
    expect(linearEmpty.status).toBe(400);

    const stripeMissing = await createConnection(milo.tokens.accessToken, 'stripe', 'stripe-no-key', {});
    expect(stripeMissing.status).toBe(400);

    const unknownConnector = await createConnection(milo.tokens.accessToken, 'asana', 'asana', { token: 'x' });
    expect(unknownConnector.status).toBe(400);

    const outsider = await createConnection(zed.tokens.accessToken, 'slack', 'nope', { accessToken: 'xoxb-value-2' });
    expect(outsider.status).toBe(404);

    expect(await prisma.integration.count({ where: { organizationId } })).toBe(rowsBefore);
    expect(await auditCount(organizationId)).toBe(before);
  });

  it('attributes keyed creates of the new connectors to the acting key', async () => {
    const before = await auditCount(organizationId);

    const keyed = await api(
      'POST',
      '/genapi/connections',
      { connectorId: 'linear', name: 'linear-keyed', credentials: { apiKey: 'lin_api_keyed_expansion_value' } },
      connKey.key,
    );
    expect(keyed.status).toBe(201);
    const keyedConnection = keyed.body as unknown as { id: string; organizationId: string };
    expect(keyedConnection.organizationId).toBe(organizationId);

    const audit = await prisma.auditEvent.findFirst({
      where: { organizationId, action: 'integration.connection.create', resourceId: keyedConnection.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(milo.userId);
    const metadata = audit!.metadata as Record<string, unknown>;
    expect(metadata.via).toBe('genapi');
    expect(metadata.apiKeyId).toBe(connKey.id);
    expect(metadata.connectorId).toBe('linear');
    expect(metadata.name).toBe('linear-keyed');
    expect(await prisma.auditEvent.count({ where: { resourceId: keyedConnection.id } })).toBe(1);
    expect(await auditCount(organizationId)).toBe(before + 1);
  });

  it('resolves a slack create double-tap with exactly one 201 and one 409', async () => {
    const before = await auditCount(organizationId);
    const rowsBefore = await prisma.integration.count({ where: { organizationId } });

    const raced = await Promise.all([
      createConnection(milo.tokens.accessToken, 'slack', 'slack-ci', { accessToken: 'xoxb-race-value-1' }),
      createConnection(tara.tokens.accessToken, 'slack', 'slack-ci', { accessToken: 'xoxb-race-value-2' }),
    ]);
    expect(sortedStatuses(raced)).toEqual([201, 409]);

    const list = await api(
      'GET',
      '/organizations/' + organizationId + '/integrations/connections',
      undefined,
      milo.tokens.accessToken,
    );
    const slackRows = (list.body as unknown as Array<{ name: string }>).filter((row) => row.name === 'slack-ci');
    expect(slackRows.length).toBe(1);
    expect(await prisma.integration.count({ where: { organizationId } })).toBe(rowsBefore + 1);
    expect(await auditCount(organizationId)).toBe(before + 1);
  });

  it('honors the ok false body law deterministically over the local receiver', async () => {
    const good = await createConnection(milo.tokens.accessToken, 'custom', 'custom-good-body', { baseUrl: receiverUrl });
    expect(good.status).toBe(201);
    const goodId = (good.body as { id: string }).id;
    const goodTest = await testConnection(milo.tokens.accessToken, goodId);
    expect(goodTest.status).toBe(201);
    const goodBody = goodTest.body as { status: string; lastTestStatus: string; lastTestDetail: string };
    expect(goodBody.status).toBe('CONNECTED');
    expect(goodBody.lastTestStatus).toBe('succeeded');
    expect(goodBody.lastTestDetail).toContain('HTTP 200');

    respondBody = '{"ok":false,"error":"invalid_auth"}';
    const okFalse = await createConnection(milo.tokens.accessToken, 'custom', 'custom-okfalse-body', { baseUrl: receiverUrl });
    expect(okFalse.status).toBe(201);
    const okFalseId = (okFalse.body as { id: string }).id;
    const okFalseTest = await testConnection(milo.tokens.accessToken, okFalseId);
    expect(okFalseTest.status).toBe(201);
    const okFalseBody = okFalseTest.body as { status: string; lastTestStatus: string; lastTestDetail: string };
    expect(okFalseBody.status).toBe('FAILED');
    expect(okFalseBody.lastTestStatus).toBe('failed');
    expect(okFalseBody.lastTestDetail).toContain('ok false');
    respondBody = 'received';

    const audit = await prisma.auditEvent.findFirst({
      where: { organizationId, action: 'integration.connection.test', resourceId: okFalseId },
    });
    expect(audit).not.toBeNull();
    expect((audit!.metadata as Record<string, unknown>).testStatus).toBe('failed');
    expect(await prisma.auditEvent.count({ where: { organizationId, action: 'integration.connection.test', resourceId: okFalseId } })).toBe(1);
  });

  it('records honest outcomes for the real providers over real outbound requests', async () => {
    const cases: Array<{ connectorId: string; name: string; credentials: Record<string, string> }> = [
      { connectorId: 'slack', name: 'slack-honest', credentials: { accessToken: 'xoxb-fake-expansion-token-value' } },
      { connectorId: 'linear', name: 'linear-honest', credentials: { apiKey: 'lin_api_fake_expansion_key_value' } },
      { connectorId: 'stripe', name: 'stripe-honest', credentials: { secretKey: 'sk_test_fake_expansion_key_value' } },
    ];
    for (const entry of cases) {
      const created = await createConnection(milo.tokens.accessToken, entry.connectorId, entry.name, entry.credentials);
      expect(created.status).toBe(201);
      const id = (created.body as { id: string }).id;

      const tested = await testConnection(milo.tokens.accessToken, id);
      expect(tested.status).toBe(201);
      const body = tested.body as { status: string; lastTestStatus: string; lastTestDetail: string };
      // A bad token draws either a real refusal from the provider or a
      // network refusal from the runner. Both are honest outcomes.
      expect(['failed', 'unreachable']).toContain(body.lastTestStatus);
      expect(body.status).toBe('FAILED');
      expect(body.lastTestDetail.length).toBeGreaterThan(0);

      const audit = await prisma.auditEvent.findFirst({
        where: { organizationId, action: 'integration.connection.test', resourceId: id },
      });
      expect(audit).not.toBeNull();
      expect(['failed', 'unreachable']).toContain((audit!.metadata as Record<string, unknown>).testStatus);
      expect(await prisma.auditEvent.count({ where: { organizationId, action: 'integration.connection.test', resourceId: id } })).toBe(1);
    }
  });

  it('resolves delete double-taps on the new connectors with exactly one winner', async () => {
    const created = await createConnection(milo.tokens.accessToken, 'stripe', 'stripe-clean', { secretKey: 'sk_test_stripe_clean_value' });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;

    const remove = (token: string) =>
      api(
        'DELETE',
        '/organizations/' + organizationId + '/integrations/connections/' + id,
        undefined,
        token,
      );
    const raced = await Promise.all([remove(milo.tokens.accessToken), remove(tara.tokens.accessToken)]);
    expect(sortedStatuses(raced)).toEqual([200, 404]);

    expect(await prisma.integration.count({ where: { id } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { organizationId, action: 'integration.connection.delete', resourceId: id } })).toBe(1);

    const unknown = await api(
      'DELETE',
      '/organizations/' + organizationId + '/integrations/connections/unknown-' + runId,
      undefined,
      milo.tokens.accessToken,
    );
    expect(unknown.status).toBe(404);
  });

  it('refuses keyed lifecycle callers uniformly on the new-connector surface', async () => {
    const rowsBefore = await prisma.integration.count({ where: { organizationId } });
    const before = await auditCount(organizationId);

    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      milo.tokens.accessToken,
    );
    expect([200, 201]).toContain(revoke.status);

    const revokedCall = await api(
      'POST',
      '/genapi/connections',
      { connectorId: 'slack', name: 'slack-revoked', credentials: { accessToken: 'xoxb-value-3' } },
      revokedKey.key,
    );
    expect(revokedCall.status).toBe(401);
    expect((revokedCall.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const anonymous = await api('POST', '/genapi/connections', {
      connectorId: 'slack',
      name: 'slack-anonymous',
      credentials: { accessToken: 'xoxb-value-4' },
    });
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { message: string }).message).toBe('A valid GENESIS API key is required.');

    expect(await prisma.integration.count({ where: { organizationId } })).toBe(rowsBefore);
    expect(await auditCount(organizationId)).toBe(before + 1);
  });
});
