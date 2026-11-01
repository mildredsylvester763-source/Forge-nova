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

/**
 * Keyed webhook read flows against the real app and the real CI
 * PostgreSQL. Grounded in the market leaders: the Stripe webhook
 * endpoints REST surface lets a restricted read key list webhook
 * endpoints, an empty organization answers an honest empty array
 * instead of an error, and the signing secret never appears in a
 * read; the GitHub hook deliveries listing keeps delivery history
 * readable with nothing more than read permission, newest first
 * capped at 100, and the GitHub single delivery read includes the
 * payload and the recorded error. The keyed routes share the very
 * cores the JWT routes use, so the two surfaces can never drift
 * apart; every read is tenant-bounded to the key organization with
 * the same uniform 404s, and reads and refusals never write audit
 * rows.
 */
suite('GENESIS keyed webhook read flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId: string;
  let foreignOrganizationId: string;
  let readerKey: KeyMaterial;
  let appKey: KeyMaterial;
  let writerKey: KeyMaterial;
  let shortLivedKey: KeyMaterial;
  let revokedKey: KeyMaterial;
  let irisKey: KeyMaterial;
  let primaryEndpointId: string;
  let deadEndpointId: string;
  let irisEndpointId: string;
  let primaryDeliveryId: string;
  let deadDeliveryId: string;
  let receiver: Server;
  let deadUrl: string;
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

  const keyed = (method: string, requestPath: string, rawKey?: string) =>
    api(method, requestPath, undefined, rawKey);

  const registerUser = async (name: string): Promise<UserContext> => {
    const email = 'genesis-gwr-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'genapi-webhook-reads-password-123',
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

  const jwtEndpointList = () =>
    api(
      'GET',
      '/organizations/' + organizationId + '/webhooks/endpoints',
      undefined,
      hank.tokens.accessToken,
    );

  const jwtEndpointHistory = (endpointId: string, status?: string) =>
    api(
      'GET',
      '/organizations/' + organizationId + '/webhooks/endpoints/' + endpointId + '/deliveries'
        + (status === undefined ? '' : '?status=' + status),
      undefined,
      hank.tokens.accessToken,
    );

  const jwtInspect = (endpointId: string, deliveryId: string) =>
    api(
      'GET',
      '/organizations/' + organizationId + '/webhooks/endpoints/' + endpointId + '/deliveries/' + deliveryId,
      undefined,
      hank.tokens.accessToken,
    );

  const keyedEndpointList = (rawKey: string) =>
    keyed('GET', '/genapi/webhook-endpoints', rawKey);

  const keyedEndpointHistory = (rawKey: string, endpointId: string, status?: string) =>
    keyed('GET', '/genapi/webhook-endpoints/' + endpointId + '/deliveries'
      + (status === undefined ? '' : '?status=' + status), rawKey);

  const keyedInspect = (rawKey: string, endpointId: string, deliveryId: string) =>
    keyed('GET', '/genapi/webhook-endpoints/' + endpointId + '/deliveries/' + deliveryId, rawKey);

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

  it('seeds two organizations, keys, endpoints, and honest deliveries', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;
    expect(foreignOrganizationId).not.toBe(organizationId);

    readerKey = await createKey(hank.tokens.accessToken, organizationId, 'Webhook Reader', ['READ_ORGANIZATION']);
    appKey = await createKey(hank.tokens.accessToken, organizationId, 'App Reader', ['READ_APPLICATIONS']);
    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'App Writer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Short Lived',
      ['READ_ORGANIZATION'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(hank.tokens.accessToken, organizationId, 'Revoked Reader', ['READ_ORGANIZATION']);
    irisKey = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Iris Reader', ['READ_ORGANIZATION']);

    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect(revoke.status).toBe(201);

    const meFresh = await keyed('GET', '/genapi/me', shortLivedKey.raw);
    expect(meFresh.status).toBe(200);

    receiver = createServer((request, response) => {
      response.statusCode = 200;
      response.end('ok');
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
    irisEndpointId = foreign.id;

    const dispatchedPrimary = await api(
      'POST',
      '/organizations/' + organizationId + '/webhooks/dispatch',
      { eventName: 'application.created', payload: { note: 'genesis-gwr-' + runId } },
      hank.tokens.accessToken,
    );
    expect(dispatchedPrimary.status).toBe(201);
    expect(dispatchedPrimary.body.matchedEndpoints).toBe(1);
    const primaryDeliveries = dispatchedPrimary.body.deliveries as unknown as Array<{ deliveryId: string; status: string }>;
    expect(primaryDeliveries.length).toBe(1);
    expect(primaryDeliveries[0].status).toBe('DELIVERED');
    primaryDeliveryId = primaryDeliveries[0].deliveryId;

    const dispatchedDead = await api(
      'POST',
      '/organizations/' + organizationId + '/webhooks/dispatch',
      { eventName: 'checkpoint.created', payload: { note: 'genesis-gwr-' + runId } },
      hank.tokens.accessToken,
    );
    expect(dispatchedDead.status).toBe(201);
    expect(dispatchedDead.body.matchedEndpoints).toBe(1);
    const deadDeliveries = dispatchedDead.body.deliveries as unknown as Array<{ deliveryId: string; status: string }>;
    expect(deadDeliveries.length).toBe(1);
    expect(deadDeliveries[0].status).toBe('PENDING');
    deadDeliveryId = deadDeliveries[0].deliveryId;
  });

  it('mirrors the JWT endpoint listing exactly and stays secret-blind', async () => {
    const jwt = await jwtEndpointList();
    expect(jwt.status).toBe(200);
    const keyedList = await keyedEndpointList(readerKey.raw);
    expect(keyedList.status).toBe(200);
    expect(keyedList.body).toEqual(jwt.body);
    const rows = keyedList.body as unknown as Array<{ id: string }>;
    expect(rows.length).toBe(2);
    expect(JSON.stringify(keyedList.body).indexOf('whsec_')).toBe(-1);
    expect(JSON.stringify(jwt.body).indexOf('whsec_')).toBe(-1);
  });

  it('tenant-bounds the listing to the key organization with one uniform 404', async () => {
    const irisList = await keyedEndpointList(irisKey.raw);
    expect(irisList.status).toBe(200);
    const irisRows = irisList.body as unknown as Array<{ id: string; organizationId: string }>;
    expect(irisRows.length).toBe(1);
    expect(irisRows[0].id).toBe(irisEndpointId);
    expect(irisRows[0].organizationId).toBe(foreignOrganizationId);

    const messages = new Set<string>();
    const foreignProbe = await keyedEndpointHistory(irisKey.raw, primaryEndpointId);
    expect(foreignProbe.status).toBe(404);
    messages.add((foreignProbe.body as { message: string }).message);
    const unknownProbe = await keyedEndpointHistory(readerKey.raw, 'does-not-exist-at-all');
    expect(unknownProbe.status).toBe(404);
    messages.add((unknownProbe.body as { message: string }).message);
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Webhook endpoint not found.');
  });

  it('mirrors the JWT per-endpoint history exactly, newest first', async () => {
    const jwt = await jwtEndpointHistory(primaryEndpointId);
    expect(jwt.status).toBe(200);
    const keyedHistory = await keyedEndpointHistory(readerKey.raw, primaryEndpointId);
    expect(keyedHistory.status).toBe(200);
    expect(keyedHistory.body).toEqual(jwt.body);
    const rows = keyedHistory.body as unknown as Array<{ id: string; createdAt: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(primaryDeliveryId);

    const deadHistory = await keyedEndpointHistory(readerKey.raw, deadEndpointId);
    expect(deadHistory.status).toBe(200);
    const deadRows = deadHistory.body as unknown as Array<{ id: string; status: string }>;
    expect(deadRows.length).toBe(1);
    expect(deadRows[0].status).toBe('PENDING');
  });

  it('honors the real status filter with named 400 parity', async () => {
    const pendingOnly = await keyedEndpointHistory(readerKey.raw, deadEndpointId, 'PENDING');
    expect(pendingOnly.status).toBe(200);
    const pendingRows = pendingOnly.body as unknown as Array<{ status: string }>;
    expect(pendingRows.length).toBe(1);
    expect(pendingRows[0].status).toBe('PENDING');

    const deliveredOnly = await keyedEndpointHistory(readerKey.raw, primaryEndpointId, 'DELIVERED');
    expect(deliveredOnly.status).toBe(200);
    const deliveredRows = deliveredOnly.body as unknown as Array<{ status: string }>;
    expect(deliveredRows.length).toBe(1);
    expect(deliveredRows[0].status).toBe('DELIVERED');

    const keyedRefusal = await keyedEndpointHistory(readerKey.raw, primaryEndpointId, 'FAILED');
    expect(keyedRefusal.status).toBe(400);
    const jwtRefusal = await jwtEndpointHistory(primaryEndpointId, 'FAILED');
    expect(jwtRefusal.status).toBe(400);
    expect((keyedRefusal.body as { message: string }).message)
      .toBe((jwtRefusal.body as { message: string }).message);
    expect((keyedRefusal.body as { message: string }).message).toBe('Unknown delivery status: FAILED');
  });

  it('mirrors the JWT delivery inspection with payload and recorded error', async () => {
    const jwt = await jwtInspect(primaryEndpointId, primaryDeliveryId);
    expect(jwt.status).toBe(200);
    const keyedInspectResult = await keyedInspect(readerKey.raw, primaryEndpointId, primaryDeliveryId);
    expect(keyedInspectResult.status).toBe(200);
    expect(keyedInspectResult.body).toEqual(jwt.body);
    expect((keyedInspectResult.body as { id: string }).id).toBe(primaryDeliveryId);

    const deadInspect = await keyedInspect(readerKey.raw, deadEndpointId, deadDeliveryId);
    expect(deadInspect.status).toBe(200);
    const deadRow = deadInspect.body as { lastError: string | null; payload: Record<string, unknown> };
    expect(deadRow.lastError).not.toBeNull();
    expect(String(deadRow.lastError)).toContain('ECONNREFUSED');
    expect(deadRow.payload.note).toBe('genesis-gwr-' + runId);
  });

  it('answers uniform 404s for unknown and foreign endpoints and cross-endpoint deliveries', async () => {
    const endpointMessages = new Set<string>();
    const unknownList = await keyedEndpointHistory(readerKey.raw, 'does-not-exist-at-all');
    expect(unknownList.status).toBe(404);
    endpointMessages.add((unknownList.body as { message: string }).message);

    const unknownInspect = await keyedInspect(readerKey.raw, 'does-not-exist-at-all', primaryDeliveryId);
    expect(unknownInspect.status).toBe(404);
    endpointMessages.add((unknownInspect.body as { message: string }).message);

    const irisEndpointList = await keyedEndpointList(readerKey.raw);
    const ids = (irisEndpointList.body as unknown as Array<{ id: string }>).map((row) => row.id);
    expect(ids).not.toContain(irisEndpointId);

    const foreignHistory = await keyedEndpointHistory(readerKey.raw, irisEndpointId);
    expect(foreignHistory.status).toBe(404);
    endpointMessages.add((foreignHistory.body as { message: string }).message);
    expect(endpointMessages.size).toBe(1);
    expect(Array.from(endpointMessages)[0]).toBe('Webhook endpoint not found.');

    const crossEndpoint = await keyedInspect(readerKey.raw, primaryEndpointId, deadDeliveryId);
    expect(crossEndpoint.status).toBe(404);
    expect((crossEndpoint.body as { message: string }).message).toBe('Webhook delivery not found.');
  });

  it('refuses keys without the organization read scope with one identical message', async () => {
    const messages = new Set<string>();
    for (const key of [appKey, writerKey]) {
      const list = await keyedEndpointList(key.raw);
      expect(list.status).toBe(403);
      messages.add((list.body as { message: string }).message);
      const history = await keyedEndpointHistory(key.raw, primaryEndpointId);
      expect(history.status).toBe(403);
      messages.add((history.body as { message: string }).message);
      const inspect = await keyedInspect(key.raw, primaryEndpointId, primaryDeliveryId);
      expect(inspect.status).toBe(403);
      messages.add((inspect.body as { message: string }).message);
    }
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('The API key does not grant the required scope.');
  });

  it('writes zero audit rows for keyed reads', async () => {
    const before = await auditCount();
    const list = await keyedEndpointList(readerKey.raw);
    expect(list.status).toBe(200);
    const history = await keyedEndpointHistory(readerKey.raw, primaryEndpointId);
    expect(history.status).toBe(200);
    const inspect = await keyedInspect(readerKey.raw, primaryEndpointId, primaryDeliveryId);
    expect(inspect.status).toBe(200);
    const after = await auditCount();
    expect(after).toBe(before);
  });

  it('answers double-tapped identical reads with identical rows', async () => {
    const raced = await Promise.all([
      keyedEndpointList(readerKey.raw),
      keyedEndpointList(readerKey.raw),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(200);
    expect(raced[0].body).toEqual(raced[1].body);
  });

  it('ends a keyed read racing a JWT dispatch in clean outcomes only', async () => {
    const raced = await Promise.all([
      keyedEndpointHistory(readerKey.raw, primaryEndpointId),
      api(
        'POST',
        '/organizations/' + organizationId + '/webhooks/dispatch',
        { eventName: 'application.created', payload: { note: 'genesis-gwr-race-' + runId } },
        hank.tokens.accessToken,
      ),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(201);

    const after = await keyedEndpointHistory(readerKey.raw, primaryEndpointId);
    expect(after.status).toBe(200);
    const rows = after.body as unknown as Array<{ id: string }>;
    expect(rows.length).toBe(2);
  });

  it('ends a keyed read racing a JWT endpoint delete cleanly whichever way it lands', async () => {
    const raced = await Promise.all([
      keyedEndpointHistory(readerKey.raw, deadEndpointId),
      api(
        'DELETE',
        '/organizations/' + organizationId + '/webhooks/endpoints/' + deadEndpointId,
        undefined,
        hank.tokens.accessToken,
      ),
    ]);
    const readOutcome = raced[0];
    const deleteOutcome = raced[1];
    expect([200, 404]).toContain(readOutcome.status);
    if (readOutcome.status === 404) {
      expect((readOutcome.body as { message: string }).message).toBe('Webhook endpoint not found.');
    }
    expect(deleteOutcome.status).toBe(200);

    const endpointRows = await prisma.webhookEndpoint.count({ where: { id: deadEndpointId } });
    expect(endpointRows).toBe(0);

    const ghost = await keyedEndpointHistory(readerKey.raw, deadEndpointId);
    expect(ghost.status).toBe(404);
    expect((ghost.body as { message: string }).message).toBe('Webhook endpoint not found.');

    const ghostList = await keyedEndpointList(readerKey.raw);
    expect(ghostList.status).toBe(200);
    const ids = (ghostList.body as unknown as Array<{ id: string }>).map((row) => row.id);
    expect(ids).not.toContain(deadEndpointId);
  });

  it('answers revoked, expired, and unauthenticated callers with the uniform 401', async () => {
    const revokedRead = await keyedEndpointList(revokedKey.raw);
    expect(revokedRead.status).toBe(401);
    expect((revokedRead.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredRead = await keyedEndpointList(shortLivedKey.raw);
    expect(expiredRead.status).toBe(401);
    expect((expiredRead.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const anonymous = await keyed('GET', '/genapi/webhook-endpoints');
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { message: string }).message).toBe('A valid GENESIS API key is required.');
  });
});
