import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as http from 'node:http';
import { PrismaService } from '../database/prisma.service';
import { SIGNATURE_HEADER, verifySignature } from '../integrations/engine/webhook-signature.engine';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

const hasDatabase = typeof process.env.DATABASE_URL === 'string'
  && process.env.DATABASE_URL.startsWith('postgres');
const hasJwtSecret = typeof process.env.JWT_ACCESS_SECRET === 'string'
  && process.env.JWT_ACCESS_SECRET.length >= 32;
const suite = hasDatabase && hasJwtSecret ? describe : describe.skip;

interface TokenPair { accessToken: string; refreshToken: string; }
interface UserContext { email: string; tokens: TokenPair; userId: string; }
interface ApiResponse { status: number; body: Record<string, unknown>; }
interface ReceivedRequest { method: string; headers: Record<string, unknown>; body: string; }

/**
 * Integration/connector platform flows against the real app and the real
 * CI Postgres. Webhook delivery is REAL end to end: a local node:http
 * receiver answers on 127.0.0.1, receives the signed POST, and the suite
 * verifies the signature with the very engine that produced it.
 * Connection tests perform real outbound HTTP against the same receiver:
 * success, remote failure, and total unreachability are all exercised.
 */
suite('GENESIS integration and webhook flows (real app, real database, real receiver)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let hans: UserContext;
  let ines: UserContext;
  let greta: UserContext;
  let ole: UserContext;
  let organizationId: string;
  let receiver: http.Server;
  let receiverUrl: string;
  let respondWithStatus = 200;
  const received: ReceivedRequest[] = [];
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
    const email = 'genesis-int-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'integration-flows-password-123',
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

  const sortedStatuses = (responses: ApiResponse[]) =>
    responses.map((response) => response.status).sort((a, b) => a - b);

  const postHits = () => received.filter((entry) => entry.method === 'POST').length;

  const createConnection = (token: string, connectorId: string, name: string, credentials: Record<string, string>) =>
    api(
      'POST',
      '/organizations/' + organizationId + '/integrations/connections',
      { connectorId, name, credentials },
      token,
    );

  const createEndpoint = (token: string, url: string, eventSubscriptions: string[]) =>
    api(
      'POST',
      '/organizations/' + organizationId + '/webhooks/endpoints',
      { url, eventSubscriptions },
      token,
    );

  const dispatch = (token: string, eventName: string, payload: Record<string, unknown>) =>
    api('POST', '/organizations/' + organizationId + '/webhooks/dispatch', { eventName, payload }, token);

  const retryDelivery = (token: string, deliveryId: string) =>
    api(
      'POST',
      '/organizations/' + organizationId + '/webhooks/deliveries/' + deliveryId + '/retry',
      {},
      token,
    );

  const backdateNextAttempt = async (deliveryId: string) => {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { nextAttemptAt: new Date(Date.now() - 60_000) },
    });
  };

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
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          method: req.method ?? '',
          headers: req.headers as Record<string, unknown>,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.statusCode = respondWithStatus;
        res.end('received');
      });
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
    const { PrismaService: Database } = await import('../database/prisma.service');
    const database = app.get(Database);
    if (createdUserIds.length > 0) {
      await database.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
      await database.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('prepares three members and an outsider', async () => {
    hans = await registerUser('hans');
    ines = await registerUser('ines');
    greta = await registerUser('greta');
    ole = await registerUser('ole');

    const organizations = await api('GET', '/organizations', undefined, hans.tokens.accessToken);
    expect(organizations.status).toBe(200);
    organizationId = (organizations.body as unknown as Array<{ id: string }>)[0].id;

    const addInes = await api(
      'POST',
      '/organizations/' + organizationId + '/members',
      { email: ines.email, role: 'ADMIN' },
      hans.tokens.accessToken,
    );
    expect(addInes.status).toBe(201);
    const addGreta = await api(
      'POST',
      '/organizations/' + organizationId + '/members',
      { email: greta.email, role: 'VIEWER' },
      hans.tokens.accessToken,
    );
    expect(addGreta.status).toBe(201);
  });

  it('offers the connector catalog to members and refuses outsiders with a uniform 404', async () => {
    const catalog = await api(
      'GET',
      '/organizations/' + organizationId + '/integrations/connectors',
      undefined,
      hans.tokens.accessToken,
    );
    expect(catalog.status).toBe(200);
    const connectors = catalog.body as unknown as Array<{
      id: string;
      label: string;
      requiredCredentials: string[];
      optionalCredentials: string[];
      testable: boolean;
    }>;
    expect(connectors.length).toBe(7);
    expect(new Set(connectors.map((entry) => entry.id)).size).toBe(7);
    connectors.forEach((entry) => {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.requiredCredentials.length).toBeGreaterThan(0);
      expect(entry.testable).toBe(true);
    });

    const viewer = await api(
      'GET',
      '/organizations/' + organizationId + '/integrations/connectors',
      undefined,
      greta.tokens.accessToken,
    );
    expect(viewer.status).toBe(200);

    const outsider = await api(
      'GET',
      '/organizations/' + organizationId + '/integrations/connectors',
      undefined,
      ole.tokens.accessToken,
    );
    expect(outsider.status).toBe(404);
  });

  it('creates a connection and never echoes credential values', async () => {
    const secretValue = 'ghp_super_secret_token_value_9f3ab2';
    const created = await createConnection(hans.tokens.accessToken, 'github', 'github-prod', { accessToken: secretValue });
    expect(created.status).toBe(201);
    const body = created.body as {
      id: string;
      connectorId: string;
      name: string;
      status: string;
      credentialShape: Record<string, number>;
    };
    expect(body.connectorId).toBe('github');
    expect(body.name).toBe('github-prod');
    expect(body.status).toBe('UNVERIFIED');
    expect(body.credentialShape.accessToken).toBe(secretValue.length);
    const serialized = JSON.stringify(created.body);
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain('credentials');
  });

  it('refuses malformed connection requests and non-admins with clean errors', async () => {
    const unknownConnector = await createConnection(hans.tokens.accessToken, 'shopify', 'shop', { token: 'x' });
    expect(unknownConnector.status).toBe(400);

    const missingCredential = await createConnection(hans.tokens.accessToken, 'github', 'no-token', {});
    expect(missingCredential.status).toBe(400);

    const unknownField = await createConnection(hans.tokens.accessToken, 'github', 'extra', {
      accessToken: 'ghp_value',
      webhookSecret: 'sneaky',
    });
    expect(unknownField.status).toBe(400);

    const emptyName = await createConnection(hans.tokens.accessToken, 'github', '   ', { accessToken: 'ghp_value' });
    expect(emptyName.status).toBe(400);

    const viewer = await createConnection(greta.tokens.accessToken, 'github', 'nope', { accessToken: 'ghp_value' });
    expect(viewer.status).toBe(404);
    const outsider = await createConnection(ole.tokens.accessToken, 'github', 'nope', { accessToken: 'ghp_value' });
    expect(outsider.status).toBe(404);
  });

  it('resolves a connection double-tap with exactly one 201 and one 409', async () => {
    const raced = await Promise.all([
      createConnection(hans.tokens.accessToken, 'gitlab', 'gitlab-ci', { accessToken: 'glpat-race-value-1' }),
      createConnection(ines.tokens.accessToken, 'gitlab', 'gitlab-ci', { accessToken: 'glpat-race-value-2' }),
    ]);
    expect(sortedStatuses(raced)).toEqual([201, 409]);

    const list = await api(
      'GET',
      '/organizations/' + organizationId + '/integrations/connections',
      undefined,
      hans.tokens.accessToken,
    );
    expect(list.status).toBe(200);
    const gitlabRows = (list.body as unknown as Array<{ name: string }>).filter((row) => row.name === 'gitlab-ci');
    expect(gitlabRows.length).toBe(1);
  });

  it('tests connections with real outbound HTTP and records honest outcomes', async () => {
    const ok = await createConnection(hans.tokens.accessToken, 'custom', 'custom-ok', { baseUrl: receiverUrl });
    expect(ok.status).toBe(201);
    const okId = (ok.body as { id: string }).id;

    const tested = await api(
      'POST',
      '/organizations/' + organizationId + '/integrations/connections/' + okId + '/test',
      {},
      hans.tokens.accessToken,
    );
    expect(tested.status).toBe(201);
    const okBody = tested.body as { status: string; lastTestStatus: string; lastTestDetail: string };
    expect(okBody.status).toBe('CONNECTED');
    expect(okBody.lastTestStatus).toBe('succeeded');
    expect(okBody.lastTestDetail).toContain('HTTP 200');

    respondWithStatus = 500;
    const failing = await createConnection(hans.tokens.accessToken, 'custom', 'custom-fail', { baseUrl: receiverUrl });
    const failId = (failing.body as { id: string }).id;
    const failed = await api(
      'POST',
      '/organizations/' + organizationId + '/integrations/connections/' + failId + '/test',
      {},
      hans.tokens.accessToken,
    );
    expect(failed.status).toBe(201);
    const failBody = failed.body as { status: string; lastTestStatus: string; lastTestDetail: string };
    expect(failBody.status).toBe('FAILED');
    expect(failBody.lastTestStatus).toBe('failed');
    expect(failBody.lastTestDetail).toContain('HTTP 500');
    respondWithStatus = 200;

    const dead = await createConnection(hans.tokens.accessToken, 'custom', 'custom-dead', {
      baseUrl: 'http://127.0.0.1:1/',
    });
    const deadId = (dead.body as { id: string }).id;
    const unreachable = await api(
      'POST',
      '/organizations/' + organizationId + '/integrations/connections/' + deadId + '/test',
      {},
      hans.tokens.accessToken,
    );
    expect(unreachable.status).toBe(201);
    const deadBody = unreachable.body as { status: string; lastTestStatus: string; lastTestDetail: string };
    expect(deadBody.status).toBe('FAILED');
    expect(deadBody.lastTestStatus).toBe('unreachable');
    expect(deadBody.lastTestDetail.length).toBeGreaterThan(0);

    const unknownTest = await api(
      'POST',
      '/organizations/' + organizationId + '/integrations/connections/does-not-exist/test',
      {},
      hans.tokens.accessToken,
    );
    expect(unknownTest.status).toBe(404);
    const viewerTest = await api(
      'POST',
      '/organizations/' + organizationId + '/integrations/connections/' + okId + '/test',
      {},
      greta.tokens.accessToken,
    );
    expect(viewerTest.status).toBe(404);
    const outsiderTest = await api(
      'POST',
      '/organizations/' + organizationId + '/integrations/connections/' + okId + '/test',
      {},
      ole.tokens.accessToken,
    );
    expect(outsiderTest.status).toBe(404);
  });

  it('resolves a connection delete double-tap with exactly one winner', async () => {
    const created = await createConnection(hans.tokens.accessToken, 'custom', 'to-delete', { baseUrl: receiverUrl });
    const id = (created.body as { id: string }).id;
    const remove = (token: string) =>
      api(
        'DELETE',
        '/organizations/' + organizationId + '/integrations/connections/' + id,
        undefined,
        token,
      );
    const raced = await Promise.all([remove(hans.tokens.accessToken), remove(ines.tokens.accessToken)]);
    expect(sortedStatuses(raced)).toEqual([200, 404]);

    const unknown = await api(
      'DELETE',
      '/organizations/' + organizationId + '/integrations/connections/does-not-exist',
      undefined,
      hans.tokens.accessToken,
    );
    expect(unknown.status).toBe(404);
    const outsider = await remove(ole.tokens.accessToken);
    expect(outsider.status).toBe(404);
  });

  it('creates webhook endpoints with reveal-once secrets and honest validation', async () => {
    const created = await createEndpoint(hans.tokens.accessToken, receiverUrl, ['deployment.*']);
    expect(created.status).toBe(201);
    const body = created.body as { id: string; secret: string; eventSubscriptions: string[] };
    expect(body.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(body.eventSubscriptions).toEqual(['deployment.*']);

    const list = await api(
      'GET',
      '/organizations/' + organizationId + '/webhooks/endpoints',
      undefined,
      hans.tokens.accessToken,
    );
    expect(list.status).toBe(200);
    const serialized = JSON.stringify(list.body);
    expect(serialized).not.toContain(body.secret);
    expect(serialized).not.toContain('secret');

    const badSubscription = await createEndpoint(hans.tokens.accessToken, receiverUrl + '/b', ['bogus.*']);
    expect(badSubscription.status).toBe(400);
    const unknownEvent = await createEndpoint(hans.tokens.accessToken, receiverUrl + '/c', ['deployment.nonexistent']);
    expect(unknownEvent.status).toBe(400);
    const badProtocol = await createEndpoint(hans.tokens.accessToken, 'ftp://' + receiverUrl.slice(7), ['all']);
    expect(badProtocol.status).toBe(400);

    const raced = await Promise.all([
      createEndpoint(hans.tokens.accessToken, receiverUrl + '/race', ['all']),
      createEndpoint(ines.tokens.accessToken, receiverUrl + '/race', ['all']),
    ]);
    expect(sortedStatuses(raced)).toEqual([201, 409]);

    const viewer = await createEndpoint(greta.tokens.accessToken, receiverUrl + '/v', ['all']);
    expect(viewer.status).toBe(404);
    const outsider = await createEndpoint(ole.tokens.accessToken, receiverUrl + '/o', ['all']);
    expect(outsider.status).toBe(404);
  });

  it('delivers a signed payload the receiver can verify end to end', async () => {
    const endpoints = await api(
      'GET',
      '/organizations/' + organizationId + '/webhooks/endpoints',
      undefined,
      hans.tokens.accessToken,
    );
    const target = (endpoints.body as unknown as Array<{ id: string; url: string; eventSubscriptions: string[] }>)
      .find((entry) => entry.url === receiverUrl);
    expect(target).toBeDefined();

    // Reveal-once: fetch the secret straight from the database for verification.
    const row = await prisma.webhookEndpoint.findUnique({ where: { id: target!.id } });
    expect(row).not.toBeNull();

    const dispatched = await dispatch(hans.tokens.accessToken, 'deployment.recorded', {
      region: 'eu-west-1',
      version: '1.0.0',
    });
    expect(dispatched.status).toBe(201);
    const dispatchBody = dispatched.body as {
      matchedEndpoints: number;
      deliveries: Array<{ deliveryId: string; status: string; lastStatusCode: number | null }>;
    };
    expect(dispatchBody.matchedEndpoints).toBe(1);
    expect(dispatchBody.deliveries.length).toBe(1);
    expect(dispatchBody.deliveries[0].status).toBe('DELIVERED');
    expect(dispatchBody.deliveries[0].lastStatusCode).toBe(200);

    const lastHit = received[received.length - 1];
    expect(lastHit.method).toBe('POST');
    const signature = String(lastHit.headers[SIGNATURE_HEADER] ?? '');
    expect(signature).toMatch(/^t=[0-9]+,v1=[0-9a-f]{64}$/);

    const verification = verifySignature({
      secret: row!.secret,
      headerValue: signature,
      body: lastHit.body,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    expect(verification).toEqual({ valid: true });

    const tampered = verifySignature({
      secret: row!.secret,
      headerValue: signature,
      body: lastHit.body + ' ',
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    expect(tampered.valid).toBe(false);

    const parsed = JSON.parse(lastHit.body) as {
      event: string;
      payload: { region: string; version: string };
      deliveryId: string;
    };
    expect(parsed.event).toBe('deployment.recorded');
    expect(parsed.payload.region).toBe('eu-west-1');
    expect(parsed.payload.version).toBe('1.0.0');
    expect(parsed.deliveryId).toBe(dispatchBody.deliveries[0].deliveryId);

    const deliveries = await api(
      'GET',
      '/organizations/' + organizationId + '/webhooks/deliveries',
      undefined,
      hans.tokens.accessToken,
    );
    const deliveredRow = (deliveries.body as unknown as Array<{ id: string; status: string; deliveredAt: string | null }>)
      .find((entry) => entry.id === dispatchBody.deliveries[0].deliveryId);
    expect(deliveredRow?.status).toBe('DELIVERED');
    expect(deliveredRow?.deliveredAt).not.toBeNull();

    const endpointAfter = await api(
      'GET',
      '/organizations/' + organizationId + '/webhooks/endpoints',
      undefined,
      hans.tokens.accessToken,
    );
    const targetAfter = (endpointAfter.body as unknown as Array<{ id: string; lastSuccessAt: string | null }>)
      .find((entry) => entry.id === target!.id);
    expect(targetAfter?.lastSuccessAt).not.toBeNull();
  });

  it('dispatches honestly: zero matches, unknown events, and refusals', async () => {
    const noMatch = await dispatch(hans.tokens.accessToken, 'checkpoint.created', { note: 'nothing listens' });
    expect(noMatch.status).toBe(201);
    const noMatchBody = noMatch.body as { matchedEndpoints: number; deliveries: unknown[] };
    expect(noMatchBody.matchedEndpoints).toBe(0);
    expect(noMatchBody.deliveries.length).toBe(0);

    const unknownEvent = await dispatch(hans.tokens.accessToken, 'totally.bogus', {});
    expect(unknownEvent.status).toBe(400);
    const grammarFail = await dispatch(hans.tokens.accessToken, 'deployment', {});
    expect(grammarFail.status).toBe(400);

    const viewer = await dispatch(greta.tokens.accessToken, 'deployment.recorded', {});
    expect(viewer.status).toBe(404);
    const outsider = await dispatch(ole.tokens.accessToken, 'deployment.recorded', {});
    expect(outsider.status).toBe(404);
  });

  it('backs off failed deliveries and exhausts after five attempts - never forever', async () => {
    respondWithStatus = 500;
    const dispatched = await dispatch(hans.tokens.accessToken, 'deployment.recorded', { attempt: 'exhaustion' });
    expect(dispatched.status).toBe(201);
    const delivery = (dispatched.body as {
      deliveries: Array<{ deliveryId: string; status: string; attempts: number; lastError: string }>;)
      ).deliveries[0];
    expect(delivery.status).toBe('PENDING');
    expect(delivery.attempts).toBe(1);
    expect(delivery.lastError).toContain('HTTP 500');

    const earlyRetry = await retryDelivery(hans.tokens.accessToken, delivery.deliveryId);
    expect(earlyRetry.status).toBe(409);

    let attempts = 1;
    while (attempts < 4) {
      await backdateNextAttempt(delivery.deliveryId);
      const retried = await retryDelivery(hans.tokens.accessToken, delivery.deliveryId);
      expect(retried.status).toBe(201);
      const retriedBody = retried.body as { status: string; attempts: number };
      expect(retriedBody.status).toBe('PENDING');
      attempts = retriedBody.attempts;
    }
    expect(attempts).toBe(4);

    await backdateNextAttempt(delivery.deliveryId);
    const finalRetry = await retryDelivery(hans.tokens.accessToken, delivery.deliveryId);
    expect(finalRetry.status).toBe(201);
    const finalBody = finalRetry.body as { status: string; attempts: number };
    expect(finalBody.status).toBe('EXHAUSTED');
    expect(finalBody.attempts).toBe(5);

    await backdateNextAttempt(delivery.deliveryId);
    const refused = await retryDelivery(hans.tokens.accessToken, delivery.deliveryId);
    expect(refused.status).toBe(409);
    respondWithStatus = 200;
  });

  it('recovers a failed delivery on its scheduled retry', async () => {
    respondWithStatus = 500;
    const dispatched = await dispatch(hans.tokens.accessToken, 'deployment.recorded', { attempt: 'recovery' });
    const delivery = (dispatched.body as {
      deliveries: Array<{ deliveryId: string; status: string }>; }).deliveries[0];
    expect(delivery.status).toBe('PENDING');
    respondWithStatus = 200;

    await backdateNextAttempt(delivery.deliveryId);
    const hitsBefore = postHits();
    const retried = await retryDelivery(hans.tokens.accessToken, delivery.deliveryId);
    expect(retried.status).toBe(201);
    const retriedBody = retried.body as { status: string; attempts: number };
    expect(retriedBody.status).toBe('DELIVERED');
    expect(retriedBody.attempts).toBe(2);
    expect(postHits()).toBe(hitsBefore + 1);
  });

  it('resolves a retry double-tap with exactly one delivery attempt', async () => {
    respondWithStatus = 500;
    const dispatched = await dispatch(hans.tokens.accessToken, 'deployment.recorded', { attempt: 'retry-race' });
    const delivery = (dispatched.body as {
      deliveries: Array<{ deliveryId: string; status: string }>; }).deliveries[0];
    expect(delivery.status).toBe('PENDING');
    respondWithStatus = 200;

    await backdateNextAttempt(delivery.deliveryId);
    const hitsBefore = postHits();
    const raced = await Promise.all([
      retryDelivery(hans.tokens.accessToken, delivery.deliveryId),
      retryDelivery(ines.tokens.accessToken, delivery.deliveryId),
    ]);
    expect(sortedStatuses(raced)).toEqual([201, 409]);
    expect(postHits()).toBe(hitsBefore + 1);

    const row = await prisma.webhookDelivery.findUnique({ where: { id: delivery.deliveryId } });
    expect(row?.attempts).toBe(2);
    expect(row?.status).toBe('DELIVERED');
  });

  it('deletes an endpoint exactly once, stops matching it, and cascades its deliveries', async () => {
    const second = await createEndpoint(hans.tokens.accessToken, receiverUrl + '/second', ['all']);
    expect(second.status).toBe(201);
    const secondId = (second.body as { id: string }).id;

    const dispatched = await dispatch(hans.tokens.accessToken, 'application.created', { source: 'race' });
    expect(dispatched.status).toBe(201);
    const dispatchBody = dispatched.body as {
      matchedEndpoints: number;
      deliveries: Array<{ deliveryId: string; endpointId: string; status: string }>;};
    expect(dispatchBody.matchedEndpoints).toBe(2);
    expect(dispatchBody.deliveries.every((entry) => entry.status === 'DELIVERED')).toBe(true);
    const secondDelivery = dispatchBody.deliveries.find((entry) => entry.endpointId === secondId);
    expect(secondDelivery).toBeDefined();

    const remove = (token: string) =>
      api(
        'DELETE',
        '/organizations/' + organizationId + '/webhooks/endpoints/' + secondId,
        undefined,
        token,
      );
    const raced = await Promise.all([remove(hans.tokens.accessToken), remove(ines.tokens.accessToken)]);
    expect(sortedStatuses(raced)).toEqual([200, 404]);

    const endpoints = await api(
      'GET',
      '/organizations/' + organizationId + '/webhooks/endpoints',
      undefined,
      hans.tokens.accessToken,
    );
    expect((endpoints.body as unknown as Array<{ id: string }>).some((entry) => entry.id === secondId)).toBe(false);

    const deliveries = await api(
      'GET',
      '/organizations/' + organizationId + '/webhooks/deliveries',
      undefined,
      hans.tokens.accessToken,
    );
    expect((deliveries.body as unknown as Array<{ id: string }>)
      .some((entry) => entry.id === secondDelivery!.deliveryId)).toBe(false);

    const afterDelete = await dispatch(hans.tokens.accessToken, 'application.created', { source: 'post-delete' });
    expect((afterDelete.body as { matchedEndpoints: number }).matchedEndpoints).toBe(1);
  });

  it('audits every integration and webhook lifecycle action', async () => {
    const trail = await api(
      'GET',
      '/organizations/' + organizationId + '/audit-events',
      undefined,
      hans.tokens.accessToken,
    );
    expect(trail.status).toBe(200);
    const actions = (trail.body as unknown as Array<{ action: string }>).map((event) => event.action);
    expect(actions).toContain('integration.connection.create');
    expect(actions).toContain('integration.connection.test');
    expect(actions).toContain('integration.connection.delete');
    expect(actions).toContain('webhook.endpoint.create');
    expect(actions).toContain('webhook.endpoint.delete');
    expect(actions).toContain('webhook.dispatch');
    expect(actions).toContain('webhook.retry');
  });
});
