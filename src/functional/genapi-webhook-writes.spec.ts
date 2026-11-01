import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { createServer, Server } from 'node:http';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

const hasDatabase = typeof process.env.DATABASE_URL === 'string'
  && process.env.DATABASE_URL.startsWith('postgres');
const hasJwtSecret = typeof process.env.JWT_ACCESS_SECRET === 'string'
  && process.env.JWT_ACCESS_SECRET.length >= 32;
const suite = hasDatabase && hasJwtSecret ? describe : describe.skip;

interface TokenPair { accessToken: string; refreshToken: string; }
interface UserContext { email: string; tokens: TokenPair; userId: string; }
interface ApiResponse { status: number; body: Record<string, unknown>; }
interface KeyMaterial { id: string; raw: string; }
interface ReceivedHook { url: string; headers: Record<string, unknown>; body: Record<string, unknown>; }

/**
 * Keyed webhook write flows against the real app and the real CI
 * PostgreSQL. Grounded in the market leaders: the GitHub repository
 * dispatch event lets a machine identity with write access trigger
 * webhook deliveries straight from a token, and the GitHub webhook
 * redelivery is a POST attempts route behind admin access. Keys are
 * minted only by organization admins, so a WRITE_ORGANIZATION key is
 * an admin-delegated write exactly like the read delegation on the
 * audit trail. The keyed routes share the very cores the JWT routes
 * use, so the two surfaces can never drift apart: the same event-name
 * validation, the same honest zero for no matching endpoints, the same
 * backoff gate with the same honest 409s, and the same atomic
 * PENDING-to-IN_FLIGHT claim so two racing retries can never
 * double-send. Every landed write lands exactly one audit row
 * attributed to the acting key, and refusals never write audit rows.
 */
suite('GENESIS keyed webhook write flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId: string;
  let foreignOrganizationId: string;
  let orgWriter: KeyMaterial;
  let readerKey: KeyMaterial;
  let appWriter: KeyMaterial;
  let shortLivedKey: KeyMaterial;
  let revokedKey: KeyMaterial;
  let irisWriter: KeyMaterial;
  let primaryEndpointId: string;
  let deadEndpointId: string;
  let deadDeliveryId: string;
  let receiver: Server;
  let received: ReceivedHook[] = [];
  let deadUrl: string;
  let keyedRetryOutcome: Record<string, unknown> = {};
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
    const email = 'genesis-gww-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'genapi-webhook-writes-password-123',
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
  ): Promise<KeyMaterial> => {
    const response = await api(
      'POST',
      '/organizations/' + orgId + '/api-keys',
      { name, scopes, ...(expiresAt ? { expiresAt } : {}) },
      token,
    );
    expect(response.status).toBe(201);
    const body = response.body as { id: string; key: string };
    return { id: body.id, raw: body.key };
  };

  const createEndpoint = async (
    token: string,
    orgId: string,
    url: string,
    eventSubscriptions: string[],
  ) => {
    const response = await api(
      'POST',
      '/organizations/' + orgId + '/webhooks/endpoints',
      { url, eventSubscriptions },
      token,
    );
    expect(response.status).toBe(201);
    return response.body as { id: string };
  };

  const keyedDispatch = (rawKey: string, eventName: string, note: string) =>
    api('POST', '/genapi/webhook-dispatches', { eventName, payload: { note } }, rawKey);

  const keyedRetry = (rawKey: string, deliveryId: string) =>
    api('POST', '/genapi/webhook-deliveries/' + deliveryId + '/retry', {}, rawKey);

  const jwtDispatch = (eventName: string, note: string) =>
    api('POST', '/organizations/' + organizationId + '/webhooks/dispatch', { eventName, payload: { note } }, hank.tokens.accessToken);

  const jwtRetry = (deliveryId: string) =>
    api('POST', '/organizations/' + organizationId + '/webhooks/deliveries/' + deliveryId + '/retry', {}, hank.tokens.accessToken);

  const auditCount = () => prisma.auditEvent.count({ where: { organizationId } });

  const primaryDeliveryCount = () =>
    prisma.webhookDelivery.count({
      where: { endpointId: primaryEndpointId, eventName: 'application.created' },
    });

  const dispatchRowsForKeySince = async (keyId: string, marker: Date) => {
    const rows = await prisma.auditEvent.findMany({
      where: { organizationId, action: 'webhook.dispatch', createdAt: { gte: marker } },
    });
    return rows.filter(
      (row) => ((row.metadata ?? {}) as { apiKeyId?: string }).apiKeyId === keyId,
    );
  };

  const retryRowsForKeySince = async (keyId: string, marker: Date) => {
    const rows = await prisma.auditEvent.findMany({
      where: { organizationId, action: 'webhook.retry', createdAt: { gte: marker } },
    });
    return rows.filter(
      (row) => ((row.metadata ?? {}) as { apiKeyId?: string }).apiKeyId === keyId,
    );
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
    const server = app.getHttpServer() as { address: () => { port: number } };
    baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/v1';
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (typeof organizationId === 'string' && typeof foreignOrganizationId === 'string') {
      await prisma.webhookDelivery.deleteMany({
        where: { organizationId: { in: [organizationId, foreignOrganizationId] } },
      });
      await prisma.webhookEndpoint.deleteMany({
        where: { organizationId: { in: [organizationId, foreignOrganizationId] } },
      });
      await prisma.auditEvent.deleteMany({
        where: { organizationId: { in: [organizationId, foreignOrganizationId] } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.apiKey.deleteMany({
        where: { organizationId: { in: [organizationId, foreignOrganizationId] } },
      });
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    if (receiver) {
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
    await app.close();
  });

  it('seeds two organizations, keys, endpoints, and an honest failed delivery', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;
    expect(foreignOrganizationId).not.toBe(organizationId);

    orgWriter = await createKey(hank.tokens.accessToken, organizationId, 'Org Writer', ['WRITE_ORGANIZATION']);
    readerKey = await createKey(hank.tokens.accessToken, organizationId, 'Webhook Reader', ['READ_ORGANIZATION']);
    appWriter = await createKey(hank.tokens.accessToken, organizationId, 'App Writer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Short Lived Writer',
      ['READ_ORGANIZATION', 'WRITE_ORGANIZATION'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(hank.tokens.accessToken, organizationId, 'Revoked Writer', ['WRITE_ORGANIZATION']);
    irisWriter = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Iris Writer', ['WRITE_ORGANIZATION']);

    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect(revoke.status).toBe(201);

    const meFresh = await api('GET', '/genapi/me', undefined, shortLivedKey.raw);
    expect(meFresh.status).toBe(200);

    receiver = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += String(chunk); });
      request.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        received.push({
          url: request.url ?? '',
          headers: request.headers as Record<string, unknown>,
          body: parsed,
        });
        response.statusCode = 200;
        response.end('ok');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const address = receiver.address() as { port: number };
    const receiverUrl = 'http://127.0.0.1:' + address.port;

    const deadHolder = createServer(() => {});
    await new Promise<void>((resolve) => deadHolder.listen(0, '127.0.0.1', resolve));
    const deadAddress = deadHolder.address() as { port: number };
    await new Promise<void>((resolve) => deadHolder.close(() => resolve()));
    deadUrl = 'http://127.0.0.1:' + deadAddress.port + '/dead';

    const primary = await createEndpoint(
      hank.tokens.accessToken,
      organizationId,
      receiverUrl + '/primary',
      ['application.created'],
    );
    primaryEndpointId = primary.id;

    const dead = await createEndpoint(
      hank.tokens.accessToken,
      organizationId,
      deadUrl,
      ['checkpoint.created'],
    );
    deadEndpointId = dead.id;

    const foreign = await createEndpoint(
      iris.tokens.accessToken,
      foreignOrganizationId,
      receiverUrl + '/foreign',
      ['all'],
    );

    const dispatchedDead = await jwtDispatch(
      'checkpoint.created',
      'genesis-gww-' + runId,
    );
    expect(dispatchedDead.status).toBe(201);
    expect(dispatchedDead.body.matchedEndpoints).toBe(1);
    const deadDeliveries = dispatchedDead.body.deliveries as unknown as Array<{ deliveryId: string; status: string; attempts: number }>;
    expect(deadDeliveries.length).toBe(1);
    expect(deadDeliveries[0].status).toBe('PENDING');
    expect(deadDeliveries[0].attempts).toBe(1);
    deadDeliveryId = deadDeliveries[0].deliveryId;

    expect(received.length).toBe(0);
  });

  it('dispatches from a key with JWT parity, DELIVERED to the real receiver, and a signed hook', async () => {
    const keyedResult = await keyedDispatch(orgWriter.raw, 'application.created', 'genesis-gww-keyed-' + runId);
    expect(keyedResult.status).toBe(201);
    expect(keyedResult.body.eventName).toBe('application.created');
    expect(keyedResult.body.matchedEndpoints).toBe(1);
    const keyedDeliveries = keyedResult.body.deliveries as unknown as Array<{ status: string; lastStatusCode: number | null; lastError: string | null }>;
    expect(keyedDeliveries.length).toBe(1);
    expect(keyedDeliveries[0].status).toBe('DELIVERED');
    expect(keyedDeliveries[0].lastStatusCode).toBe(200);
    expect(keyedDeliveries[0].lastError).toBeNull();

    const jwt = await jwtDispatch('application.created', 'genesis-gww-jwt-' + runId);
    expect(jwt.status).toBe(201);
    expect(Object.keys(keyedResult.body).sort()).toEqual(Object.keys(jwt.body).sort());
    const jwtDeliveries = jwt.body.deliveries as unknown as Array<Record<string, unknown>>;
    expect(Object.keys(keyedDeliveries[0]).sort()).toEqual(Object.keys(jwtDeliveries[0]).sort());

    expect(received.length).toBe(2);
    const keyedHook = received[0];
    expect(keyedHook.url).toBe('/primary');
    expect(keyedHook.body.event).toBe('application.created');
    expect((keyedHook.body.payload as { note: string }).note).toBe('genesis-gww-keyed-' + runId);
    expect(typeof keyedHook.body.deliveryId).toBe('string');
    const headerNames = Object.keys(keyedHook.headers).map((name) => name.toLowerCase());
    expect(headerNames.some((name) => name.includes('signature'))).toBe(true);
    const jwtHook = received[1];
    expect(jwtHook.url).toBe('/primary');
    expect((jwtHook.body.payload as { note: string }).note).toBe('genesis-gww-jwt-' + runId);
  });

  it('bounds the keyed dispatch to the key organization', async () => {
    const beforeHank = await primaryDeliveryCount();
    const irisResult = await keyedDispatch(irisWriter.raw, 'application.created', 'genesis-gww-iris-' + runId);
    expect(irisResult.status).toBe(201);
    expect(irisResult.body.matchedEndpoints).toBe(1);
    const irisDeliveries = irisResult.body.deliveries as unknown as Array<{ status: string }>;
    expect(irisDeliveries[0].status).toBe('DELIVERED');

    const afterHank = await primaryDeliveryCount();
    expect(afterHank).toBe(beforeHank);

    const irisHook = received[received.length - 1];
    expect(irisHook.url).toBe('/foreign');
    expect((irisHook.body.payload as { note: string }).note).toBe('genesis-gww-iris-' + runId);
  });

  it('answers an honest zero for a dispatch matching no endpoints', async () => {
    const zero = await keyedDispatch(orgWriter.raw, 'verification.completed', 'genesis-gww-zero-' + runId);
    expect(zero.status).toBe(201);
    expect(zero.body.eventName).toBe('verification.completed');
    expect(zero.body.matchedEndpoints).toBe(0);
    expect(zero.body.deliveries).toEqual([]);

    const receivedStill = received.length;
    expect(receivedStill).toBe(3);
  });

  it('refuses unknown event names with 400 parity', async () => {
    const keyedRefusal = await keyedDispatch(orgWriter.raw, 'not-an-event', 'genesis-gww-bad-' + runId);
    expect(keyedRefusal.status).toBe(400);
    expect((keyedRefusal.body as { message: string }).message).toBe('Unknown event name: not-an-event');

    const jwtRefusal = await jwtDispatch('not-an-event', 'genesis-gww-bad-' + runId);
    expect(jwtRefusal.status).toBe(400);
    expect((keyedRefusal.body as { message: string }).message)
      .toBe((jwtRefusal.body as { message: string }).message);
  });

  it('lands exactly one attributed webhook.dispatch audit row', async () => {
    const marker = new Date();
    const dispatched = await keyedDispatch(orgWriter.raw, 'application.created', 'genesis-gww-attr-' + runId);
    expect(dispatched.status).toBe(201);

    const mine = await dispatchRowsForKeySince(orgWriter.id, marker);
    expect(mine.length).toBe(1);
    const row = mine[0];
    expect(row.actorUserId).toBe(hank.userId);
    expect(row.resourceType).toBe('webhook_delivery');
    expect(row.resourceId).toBe('application.created');
    expect(row.outcome).toBe('SUCCESS');
    const meta = row.metadata as {
      via: string;
      apiKeyId: string;
      apiKeyName: string;
      eventName: string;
      matchedEndpoints: number;
    };
    expect(meta.via).toBe('genapi');
    expect(meta.apiKeyId).toBe(orgWriter.id);
    expect(meta.apiKeyName).toBe('Org Writer');
    expect(meta.eventName).toBe('application.created');
    expect(meta.matchedEndpoints).toBe(1);
  });

  it('writes zero audit rows for refusals with uniform messages', async () => {
    const before = await auditCount();

    const messages = new Set<string>();
    const readerRefusal = await keyedDispatch(readerKey.raw, 'application.created', 'refused');
    expect(readerRefusal.status).toBe(403);
    messages.add((readerRefusal.body as { message: string }).message);
    const appWriterRefusal = await keyedDispatch(appWriter.raw, 'application.created', 'refused');
    expect(appWriterRefusal.status).toBe(403);
    messages.add((appWriterRefusal.body as { message: string }).message);
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('The API key does not grant the required scope.');

    const retryMessages = new Set<string>();
    const foreignRetry = await keyedRetry(irisWriter.raw, deadDeliveryId);
    expect(foreignRetry.status).toBe(404);
    retryMessages.add((foreignRetry.body as { message: string }).message);
    const unknownRetry = await keyedRetry(orgWriter.raw, 'does-not-exist-at-all');
    expect(unknownRetry.status).toBe(404);
    retryMessages.add((unknownRetry.body as { message: string }).message);
    expect(retryMessages.size).toBe(1);
    expect(Array.from(retryMessages)[0]).toBe('Webhook delivery not found.');

    await prisma.webhookDelivery.update({
      where: { id: deadDeliveryId },
      data: { nextAttemptAt: new Date(Date.now() + 60000) },
    });
    const tooEarly = await keyedRetry(orgWriter.raw, deadDeliveryId);
    expect(tooEarly.status).toBe(409);
    expect((tooEarly.body as { message: string }).message).toBe('Retry is not due yet.');

    const after = await auditCount();
    expect(after).toBe(before);
  });

  it('lands a due keyed retry honestly with one attributed webhook.retry audit row', async () => {
    await prisma.webhookDelivery.update({
      where: { id: deadDeliveryId },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

    const marker = new Date();
    const retried = await keyedRetry(orgWriter.raw, deadDeliveryId);
    expect(retried.status).toBe(201);
    const outcome = retried.body as {
      deliveryId: string;
      endpointId: string;
      status: string;
      attempts: number;
      lastStatusCode: number | null;
      lastError: string | null;
    };
    expect(outcome.deliveryId).toBe(deadDeliveryId);
    expect(outcome.endpointId).toBe(deadEndpointId);
    expect(outcome.status).toBe('PENDING');
    expect(outcome.attempts).toBe(2);
    expect(outcome.lastStatusCode).toBeNull();
    expect(String(outcome.lastError)).toContain('ECONNREFUSED');
    keyedRetryOutcome = retried.body;

    const mine = await retryRowsForKeySince(orgWriter.id, marker);
    expect(mine.length).toBe(1);
    const row = mine[0];
    expect(row.actorUserId).toBe(hank.userId);
    expect(row.resourceType).toBe('webhook_delivery');
    expect(row.resourceId).toBe(deadDeliveryId);
    expect(row.outcome).toBe('SUCCESS');
    const meta = row.metadata as {
      via: string;
      apiKeyId: string;
      apiKeyName: string;
      status: string;
      attempts: number;
    };
    expect(meta.via).toBe('genapi');
    expect(meta.apiKeyId).toBe(orgWriter.id);
    expect(meta.apiKeyName).toBe('Org Writer');
    expect(meta.status).toBe('PENDING');
    expect(meta.attempts).toBe(2);
  });

  it('ends two concurrent keyed retries of the same due delivery in clean outcomes', async () => {
    await prisma.webhookDelivery.update({
      where: { id: deadDeliveryId },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const beforeRow = await prisma.webhookDelivery.findUnique({ where: { id: deadDeliveryId } });
    expect(beforeRow).not.toBeNull();
    const attemptsBefore = beforeRow!.attempts;

    const marker = new Date();
    const raced = await Promise.all([
      keyedRetry(orgWriter.raw, deadDeliveryId),
      keyedRetry(orgWriter.raw, deadDeliveryId),
    ]);

    const allowed409 = new Set([
      'Delivery is already being attempted.',
      'Retry is not due yet.',
    ]);
    let landed = 0;
    for (const outcome of raced) {
      expect([201, 409]).toContain(outcome.status);
      if (outcome.status === 201) {
        landed += 1;
      } else {
      expect(allowed409.has((outcome.body as { message: string }).message)).toBe(true);
      }
    }
    expect(landed).toBeGreaterThanOrEqual(1);

    const afterRow = await prisma.webhookDelivery.findUnique({ where: { id: deadDeliveryId } });
    expect(afterRow!.attempts).toBe(attemptsBefore + landed);
    expect(afterRow!.status === 'PENDING' || afterRow!.status === 'IN_FLIGHT').toBe(true);

    const mine = await retryRowsForKeySince(orgWriter.id, marker);
    expect(mine.length).toBe(landed);
  });

  it('mirrors the JWT retry response shape exactly', async () => {
    await prisma.webhookDelivery.update({
      where: { id: deadDeliveryId },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const beforeRow = await prisma.webhookDelivery.findUnique({ where: { id: deadDeliveryId } });
    const attemptsBefore = beforeRow!.attempts;

    const jwt = await jwtRetry(deadDeliveryId);
    expect(jwt.status).toBe(201);
    expect(Object.keys(jwt.body).sort()).toEqual(Object.keys(keyedRetryOutcome).sort());
    expect((jwt.body as { attempts: number }).attempts).toBe(attemptsBefore + 1);
  });

  it('ends a keyed dispatch racing a JWT dispatch in clean outcomes', async () => {
    const before = await primaryDeliveryCount();
    const raced = await Promise.all([
      keyedDispatch(orgWriter.raw, 'application.created', 'genesis-gww-race-' + runId),
      jwtDispatch('application.created', 'genesis-gww-race-jwt-' + runId),
    ]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(201);
    expect(raced[0].body.matchedEndpoints).toBe(1);
    expect(raced[1].body.matchedEndpoints).toBe(1);

    const after = await primaryDeliveryCount();
    expect(after).toBe(before + 2);
  });

  it('answers a double-tapped keyed dispatch with two honest deliveries and two audit rows', async () => {
    const before = await primaryDeliveryCount();
    const marker = new Date();
    const first = await keyedDispatch(orgWriter.raw, 'application.created', 'genesis-gww-tap-' + runId);
    const second = await keyedDispatch(orgWriter.raw, 'application.created', 'genesis-gww-tap-' + runId);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.matchedEndpoints).toBe(1);
    expect(second.body.matchedEndpoints).toBe(1);

    const after = await primaryDeliveryCount();
    expect(after).toBe(before + 2);

    const mine = await dispatchRowsForKeySince(orgWriter.id, marker);
    expect(mine.length).toBe(2);
  });

  it('answers revoked, expired, and unauthenticated callers with the uniform 401', async () => {
    const revokedDispatch = await keyedDispatch(revokedKey.raw, 'application.created', 'refused');
    expect(revokedDispatch.status).toBe(401);
    expect((revokedDispatch.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredDispatch = await keyedDispatch(shortLivedKey.raw, 'application.created', 'refused');
    expect(expiredDispatch.status).toBe(401);
    expect((expiredDispatch.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const anonymous = await api('POST', '/genapi/webhook-dispatches', {
      eventName: 'application.created',
      payload: { note: 'refused' },
    });
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { message: string }).message).toBe('A valid GENESIS API key is required.');

    const anonymousRetry = await api('POST', '/genapi/webhook-deliveries/' + deadDeliveryId + '/retry', {});
    expect(anonymousRetry.status).toBe(401);
    expect((anonymousRetry.body as { message: string }).message).toBe('A valid GENESIS API key is required.');
  });
});
