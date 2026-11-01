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
 * Keyed webhook endpoint management flows against the real app and the
 * real CI PostgreSQL. Grounded in the market leaders: the Stripe
 * webhook endpoint create builds the endpoint from a write-capable key
 * and populates the signing secret in the create response exactly once,
 * the Stripe update changes only the fields sent, and the GitHub repo
 * webhook delete and ping run behind the Webhooks write permission.
 * Keys are minted only by organization admins, so a WRITE_ORGANIZATION
 * key is an admin-delegated write exactly like the read delegation on
 * the audit trail. The keyed routes share the very cores the JWT routes
 * use, so the two surfaces can never drift apart: the same reveal-once
 * secret law, the same honest no-op for an empty update, the same
 * guarded delete where racing deletes get one success and one 404, and
 * the same atomic rotation claim. Every landed write lands exactly one
 * audit row attributed to the acting key, and refusals never write
 * audit rows.
 */
suite('GENESIS keyed webhook endpoint write flows (real app, real database)', () => {
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
  let keyedEndpointId: string;
  let keyedCreateSecret: string;
  let deadEndpointId: string;
  let receiver: Server;
  let received: ReceivedHook[] = [];
  let receiverUrl: string;
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

  const registerUser = async (name: string): Promise<UserContext> => {
    const email = 'genesis-gew-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'genapi-endpoint-writes-password-123',
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

  const keyedCreate = (rawKey: string, url: string, eventSubscriptions: string[]) =>
    api('POST', '/genapi/webhook-endpoints', { url, eventSubscriptions }, rawKey);

  const keyedUpdate = (rawKey: string, endpointId: string, dto: Record<string, unknown>) =>
    api('POST', '/genapi/webhook-endpoints/' + endpointId + '/update', dto, rawKey);

  const keyedDelete = (rawKey: string, endpointId: string) =>
    api('POST', '/genapi/webhook-endpoints/' + endpointId + '/delete', {}, rawKey);

  const keyedPing = (rawKey: string, endpointId: string) =>
    api('POST', '/genapi/webhook-endpoints/' + endpointId + '/ping', {}, rawKey);

  const keyedRotate = (rawKey: string, endpointId: string) =>
    api('POST', '/genapi/webhook-endpoints/' + endpointId + '/rotate-secret', {}, rawKey);

  const jwtCreate = (url: string, eventSubscriptions: string[]) =>
    api('POST', '/organizations/' + organizationId + '/webhooks/endpoints', { url, eventSubscriptions }, hank.tokens.accessToken);

  const jwtRotate = (endpointId: string) =>
    api('POST', '/organizations/' + organizationId + '/webhooks/endpoints/' + endpointId + '/rotate-secret', {}, hank.tokens.accessToken);

  const auditCount = () => prisma.auditEvent.count({ where: { organizationId } });

  const rowsForSince = async (action: string, keyId: string, marker: Date) => {
    const rows = await prisma.auditEvent.findMany({
      where: { organizationId, action, createdAt: { gte: marker } },
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

  it('seeds two organizations, six keys, a real receiver, and a dead URL', async () => {
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
    readerKey = await createKey(hank.tokens.accessToken, organizationId, 'Endpoint Reader', ['READ_ORGANIZATION']);
    appWriter = await createKey(hank.tokens.accessToken, organizationId, 'App Writer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Short Lived Writer',
      ['READ_ORGANIZATION', 'WRITE_ORGANIZATION'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(hank.tokens.accessToken, organizationId, 'Revoked Writer', ['WRITE_ORGANIZATION']);
    irisWriter = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Iris Writer', ['READ_ORGANIZATION', 'WRITE_ORGANIZATION']);

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
    receiverUrl = 'http://127.0.0.1:' + address.port;

    const deadHolder = createServer(() => {});
    await new Promise<void>((resolve) => deadHolder.listen(0, '127.0.0.1', resolve));
    const deadAddress = deadHolder.address() as { port: number };
    await new Promise<void>((resolve) => deadHolder.close(() => resolve()));
    deadUrl = 'http://127.0.0.1:' + deadAddress.port + '/dead';

    const dead = await keyedCreate(orgWriter.raw, deadUrl, ['checkpoint.created']);
    expect(dead.status).toBe(201);
    deadEndpointId = (dead.body as { id: string }).id;
    expect(typeof deadEndpointId).toBe('string');

    expect(received.length).toBe(0);
  });

  it('creates an endpoint from a key with JWT parity and a reveal-once secret', async () => {
    const marker = new Date();
    const keyed = await keyedCreate(orgWriter.raw, receiverUrl + '/keyed-primary', ['application.created']);
    expect(keyed.status).toBe(201);
    keyedEndpointId = (keyed.body as { id: string }).id;
    keyedCreateSecret = (keyed.body as { secret: string }).secret;
    expect(keyedCreateSecret.startsWith('whsec_')).toBe(true);

    const jwt = await jwtCreate(receiverUrl + '/jwt-primary', ['checkpoint.created']);
    expect(jwt.status).toBe(201);
    expect(Object.keys(keyed.body).sort()).toEqual(Object.keys(jwt.body).sort());

    const listing = await api('GET', '/genapi/webhook-endpoints', undefined, readerKey.raw);
    expect(listing.status).toBe(200);
    const rows = listing.body as unknown as Array<Record<string, unknown>>;
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(keyedEndpointId);
    expect(ids).toContain((jwt.body as { id: string }).id);
    for (const row of rows) {
      expect('secret' in row).toBe(false);
    }

    const mine = await rowsForSince('webhook.endpoint.create', orgWriter.id, marker);
    expect(mine.length).toBe(1);
    const row = mine[0];
    expect(row.actorUserId).toBe(hank.userId);
    expect(row.resourceType).toBe('webhook_endpoint');
    expect(row.resourceId).toBe(keyedEndpointId);
    expect(row.outcome).toBe('SUCCESS');
    const meta = row.metadata as {
      via: string;
      apiKeyId: string;
      apiKeyName: string;
      url: string;
      eventSubscriptions: string[];
    };
    expect(meta.via).toBe('genapi');
    expect(meta.apiKeyId).toBe(orgWriter.id);
    expect(meta.apiKeyName).toBe('Org Writer');
    expect(meta.url).toBe(receiverUrl + '/keyed-primary');
    expect(meta.eventSubscriptions).toEqual(['application.created']);
  });

  it('refuses bad creates with named 400s, 409 parity, and zero audit rows', async () => {
    const before = await auditCount();

    const badUrl = await keyedCreate(orgWriter.raw, 'not-a-url', ['application.created']);
    expect(badUrl.status).toBe(400);
    expect((badUrl.body as { message: string }).message).toBe('Webhook URL must be a valid URL.');

    const badProtocol = await keyedCreate(orgWriter.raw, 'ftp://example.com/hook', ['application.created']);
    expect(badProtocol.status).toBe(400);
    expect((badProtocol.body as { message: string }).message).toBe('Webhook URL must use http or https.');

    const badSubscription = await keyedCreate(orgWriter.raw, receiverUrl + '/never-created', ['not-a-subscription']);
    expect(badSubscription.status).toBe(400);
    expect((badSubscription.body as { message: string }).message).toBe('Invalid event subscription: not-a-subscription');

    const keyedDuplicate = await keyedCreate(orgWriter.raw, receiverUrl + '/keyed-primary', ['application.created']);
    expect(keyedDuplicate.status).toBe(409);
    const jwtDuplicate = await jwtCreate(receiverUrl + '/keyed-primary', ['application.created']);
    expect(jwtDuplicate.status).toBe(409);
    expect((keyedDuplicate.body as { message: string }).message)
      .toBe((jwtDuplicate.body as { message: string }).message);
    expect((keyedDuplicate.body as { message: string }).message)
      .toBe('A webhook endpoint with this URL already exists.');

    const after = await auditCount();
    expect(after).toBe(before);
  });

  it('honors the keyed partial update law with an honest empty no-op', async () => {
    const before = await auditCount();
    const empty = await keyedUpdate(orgWriter.raw, keyedEndpointId, {});
    expect(empty.status).toBe(201);
    expect((empty.body as { url: string }).url).toBe(receiverUrl + '/keyed-primary');
    expect('secret' in empty.body).toBe(false);
    const afterEmpty = await auditCount();
    expect(afterEmpty).toBe(before);

    const marker = new Date();
    const updated = await keyedUpdate(orgWriter.raw, keyedEndpointId, {
      url: receiverUrl + '/keyed-primary-v2',
      active: false,
    });
    expect(updated.status).toBe(201);
    expect((updated.body as { url: string }).url).toBe(receiverUrl + '/keyed-primary-v2');
    expect((updated.body as { active: boolean }).active).toBe(false);
    expect('secret' in updated.body).toBe(false);

    const mine = await rowsForSince('webhook.endpoint.update', orgWriter.id, marker);
    expect(mine.length).toBe(1);
    const row = mine[0];
    expect(row.resourceId).toBe(keyedEndpointId);
    const meta = row.metadata as {
      via: string;
      apiKeyId: string;
      url: string;
      active: boolean;
    };
    expect(meta.via).toBe('genapi');
    expect(meta.apiKeyId).toBe(orgWriter.id);
    expect(meta.url).toBe(receiverUrl + '/keyed-primary-v2');
    expect(meta.active).toBe(false);

    await keyedUpdate(orgWriter.raw, keyedEndpointId, { active: true });
    const unknown = await keyedUpdate(orgWriter.raw, 'does-not-exist-at-all', { active: true });
    expect(unknown.status).toBe(404);
    expect((unknown.body as { message: string }).message).toBe('Webhook endpoint not found.');
  });

  it('deletes from a key with a uniform 404 and one attributed audit row', async () => {
    const seeded = await keyedCreate(orgWriter.raw, receiverUrl + '/to-delete', ['all']);
    expect(seeded.status).toBe(201);
    const doomedId = (seeded.body as { id: string }).id;

    const foreign = await keyedDelete(irisWriter.raw, keyedEndpointId);
    expect(foreign.status).toBe(404);
    const unknown = await keyedDelete(orgWriter.raw, 'does-not-exist-at-all');
    expect(unknown.status).toBe(404);
    expect((foreign.body as { message: string }).message)
      .toBe((unknown.body as { message: string }).message);
    expect((unknown.body as { message: string }).message).toBe('Webhook endpoint not found.');

    const marker = new Date();
    const first = await keyedDelete(orgWriter.raw, doomedId);
    expect(first.status).toBe(201);
    expect((first.body as { deleted: boolean }).deleted).toBe(true);
    expect((first.body as { endpointId: string }).endpointId).toBe(doomedId);

    const second = await keyedDelete(orgWriter.raw, doomedId);
    expect(second.status).toBe(404);
    expect((second.body as { message: string }).message).toBe('Webhook endpoint not found.');

    const gone = await prisma.webhookEndpoint.findUnique({ where: { id: doomedId } });
    expect(gone).toBeNull();

    const mine = await rowsForSince('webhook.endpoint.delete', orgWriter.id, marker);
    expect(mine.length).toBe(1);
    const row = mine[0];
    expect(row.resourceId).toBe(doomedId);
    expect(row.outcome).toBe('SUCCESS');
    const meta = row.metadata as { via: string; apiKeyId: string };
    expect(meta.via).toBe('genapi');
    expect(meta.apiKeyId).toBe(orgWriter.id);
  });

  it('pings from a key: DELIVERED to the real receiver, honest PENDING to the dead endpoint', async () => {
    const marker = new Date();
    const pinged = await keyedPing(orgWriter.raw, keyedEndpointId);
    expect(pinged.status).toBe(201);
    const live = pinged.body as {
      endpointId: string;
      status: string;
      attempts: number;
      lastStatusCode: number | null;
      lastError: string | null;
    };
    expect(live.endpointId).toBe(keyedEndpointId);
    expect(live.status).toBe('DELIVERED');
    expect(live.attempts).toBe(1);
    expect(live.lastStatusCode).toBe(200);
    expect(live.lastError).toBeNull();

    expect(received.length).toBe(1);
    const hook = received[0];
    expect(hook.url).toBe('/keyed-primary-v2');
    expect(hook.body.event).toBe('ping');
    const headerNames = Object.keys(hook.headers).map((name) => name.toLowerCase());
    expect(headerNames.some((name) => name.includes('signature'))).toBe(true);

    const deadPing = await keyedPing(orgWriter.raw, deadEndpointId);
    expect(deadPing.status).toBe(201);
    const deadOutcome = deadPing.body as {
      status: string;
      attempts: number;
      lastStatusCode: number | null;
      lastError: string | null;
    };
    expect(deadOutcome.status).toBe('PENDING');
    expect(deadOutcome.attempts).toBe(1);
    expect(deadOutcome.lastStatusCode).toBeNull();
    expect(String(deadOutcome.lastError)).toContain('ECONNREFUSED');

    const mine = await rowsForSince('webhook.endpoint.ping', orgWriter.id, marker);
    expect(mine.length).toBe(2);
    const pingedIds = mine.map(
      (row) => ((row.metadata ?? {}) as { endpointId?: string }).endpointId,
    );
    expect(pingedIds).toContain(keyedEndpointId);
    expect(pingedIds).toContain(deadEndpointId);
    for (const row of mine) {
      const meta = row.metadata as { via: string; apiKeyId: string };
      expect(meta.via).toBe('genapi');
      expect(meta.apiKeyId).toBe(orgWriter.id);
    }
  });

  it('rotates from a key: fresh reveal-once secret and a delivery that still lands', async () => {
    const marker = new Date();
    const rotated = await keyedRotate(orgWriter.raw, keyedEndpointId);
    expect(rotated.status).toBe(201);
    const freshSecret = (rotated.body as { secret: string }).secret;
    expect(freshSecret.startsWith('whsec_')).toBe(true);
    expect(freshSecret).not.toBe(keyedCreateSecret);
    expect('secret' in (rotated.body as Record<string, unknown>)).toBe(true);

    const dispatched = await api(
      'POST',
      '/genapi/webhook-dispatches',
      { eventName: 'application.created', payload: { note: 'genesis-gew-' + runId } },
      orgWriter.raw,
    );
    expect(dispatched.status).toBe(201);
    const deliveries = dispatched.body.deliveries as unknown as Array<{ status: string; lastStatusCode: number | null }>;
    expect(dispatched.body.matchedEndpoints).toBe(1);
    expect(deliveries[0].status).toBe('DELIVERED');
    expect(deliveries[0].lastStatusCode).toBe(200);
    expect(received.length).toBe(2);
    expect(received[1].body.event).toBe('application.created');

    const mine = await rowsForSince('webhook.endpoint.rotate_secret', orgWriter.id, marker);
    expect(mine.length).toBe(1);
    const row = mine[0];
    expect(row.resourceId).toBe(keyedEndpointId);
    const meta = row.metadata as { via: string; apiKeyId: string };
    expect(meta.via).toBe('genapi');
    expect(meta.apiKeyId).toBe(orgWriter.id);
  });

  it('bounds every keyed endpoint operation to the key organization', async () => {
    const irisEndpoint = await keyedCreate(irisWriter.raw, receiverUrl + '/iris-created', ['all']);
    expect(irisEndpoint.status).toBe(201);
    const irisEndpointId = (irisEndpoint.body as { id: string }).id;

    const hankListing = await api('GET', '/genapi/webhook-endpoints', undefined, readerKey.raw);
    const hankIds = (hankListing.body as unknown as Array<{ id: string }>).map((row) => row.id);
    expect(hankIds).not.toContain(irisEndpointId);

    const irisListing = await api('GET', '/genapi/webhook-endpoints', undefined, irisWriter.raw);
    const irisIds = (irisListing.body as unknown as Array<{ id: string }>).map((row) => row.id);
    expect(irisIds).toContain(irisEndpointId);
    expect(irisIds).not.toContain(keyedEndpointId);

    const before = await auditCount();
    const messages = new Set<string>();
    for (const refusal of [
      await keyedUpdate(irisWriter.raw, keyedEndpointId, { active: false }),
      await keyedDelete(irisWriter.raw, keyedEndpointId),
      await keyedPing(irisWriter.raw, keyedEndpointId),
      await keyedRotate(irisWriter.raw, keyedEndpointId),
    ]) {
      expect(refusal.status).toBe(404);
      messages.add((refusal.body as { message: string }).message);
    }
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Webhook endpoint not found.');
    const after = await auditCount();
    expect(after).toBe(before);
  });

  it('refuses all five routes without WRITE_ORGANIZATION and never audits', async () => {
    const before = await auditCount();
    const messages = new Set<string>();

    for (const raw of [readerKey.raw, appWriter.raw]) {
      const create = await keyedCreate(raw, receiverUrl + '/refused-create', ['all']);
      expect(create.status).toBe(403);
      messages.add((create.body as { message: string }).message);
      const update = await keyedUpdate(raw, keyedEndpointId, { active: false });
      expect(update.status).toBe(403);
      messages.add((update.body as { message: string }).message);
      const remove = await keyedDelete(raw, keyedEndpointId);
      expect(remove.status).toBe(403);
      messages.add((remove.body as { message: string }).message);
      const ping = await keyedPing(raw, keyedEndpointId);
      expect(ping.status).toBe(403);
      messages.add((ping.body as { message: string }).message);
      const rotate = await keyedRotate(raw, keyedEndpointId);
      expect(rotate.status).toBe(403);
      messages.add((rotate.body as { message: string }).message);
    }

    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('The API key does not grant the required scope.');
    const after = await auditCount();
    expect(after).toBe(before);
  });

  it('answers revoked, expired, and unauthenticated callers with the uniform 401', async () => {
    const revokedCreate = await keyedCreate(revokedKey.raw, receiverUrl + '/refused', ['all']);
    expect(revokedCreate.status).toBe(401);
    expect((revokedCreate.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredUpdate = await keyedUpdate(shortLivedKey.raw, keyedEndpointId, { active: false });
    expect(expiredUpdate.status).toBe(401);
    expect((expiredUpdate.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const anonymousCreate = await api('POST', '/genapi/webhook-endpoints', {
      url: receiverUrl + '/anonymous',
      eventSubscriptions: ['all'],
    });
    expect(anonymousCreate.status).toBe(401);
    expect((anonymousCreate.body as { message: string }).message).toBe('A valid GENESIS API key is required.');

    const anonymousDelete = await api('POST', '/genapi/webhook-endpoints/' + keyedEndpointId + '/delete', {});
    expect(anonymousDelete.status).toBe(401);
    expect((anonymousDelete.body as { message: string }).message).toBe('A valid GENESIS API key is required.');
  });

  it('ends a keyed update racing a keyed delete in clean outcomes with the endpoint gone', async () => {
    const seeded = await keyedCreate(orgWriter.raw, receiverUrl + '/race-target', ['all']);
    expect(seeded.status).toBe(201);
    const raceId = (seeded.body as { id: string }).id;

    const marker = new Date();
    const raced = await Promise.all([
      keyedUpdate(orgWriter.raw, raceId, { url: receiverUrl + '/race-final' }),
      keyedDelete(orgWriter.raw, raceId),
    ]);

    for (const outcome of raced) {
      expect([201, 404]).toContain(outcome.status);
    }
    expect((raced[1].body as { deleted?: boolean }).deleted === true
      || (raced[1].body as { message?: string }).message === 'Webhook endpoint not found.').toBe(true);

    const gone = await prisma.webhookEndpoint.findUnique({ where: { id: raceId } });
    expect(gone).toBeNull();

    const deleteRows = await rowsForSince('webhook.endpoint.delete', orgWriter.id, marker);
    expect(deleteRows.length).toBe(1);
    const updateRows = await rowsForSince('webhook.endpoint.update', orgWriter.id, marker);
    expect(updateRows.length).toBeLessThanOrEqual(1);
  });

  it('ends a keyed rotation racing a JWT rotation with both secrets honest', async () => {
    const marker = new Date();
    const raced = await Promise.all([
      keyedRotate(orgWriter.raw, keyedEndpointId),
      jwtRotate(keyedEndpointId),
    ]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(201);
    const keyedSecret = (raced[0].body as { secret: string }).secret;
    const jwtSecret = (raced[1].body as { secret: string }).secret;
    expect(keyedSecret).not.toBe(jwtSecret);

    const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: keyedEndpointId } });
    expect(endpoint).not.toBeNull();
    expect(endpoint!.secret === keyedSecret || endpoint!.secret === jwtSecret).toBe(true);

    const rows = await prisma.auditEvent.findMany({
      where: { organizationId, action: 'webhook.endpoint.rotate_secret', createdAt: { gte: marker } },
    });
    expect(rows.length).toBe(2);
    const keyedRows = rows.filter(
      (row) => ((row.metadata ?? {}) as { apiKeyId?: string }).apiKeyId === orgWriter.id,
    );
    expect(keyedRows.length).toBe(1);
    const plainRows = rows.filter(
      (row) => ((row.metadata ?? {}) as { apiKeyId?: string }).apiKeyId === undefined,
    );
    expect(plainRows.length).toBe(1);
  });
});
