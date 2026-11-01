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
interface ReceiverHit { body: Record<string, unknown>; receivedAt: number; }

/**
 * Per-endpoint webhook delivery history and single delivery inspection
 * against the real app and the real CI PostgreSQL. Grounded in the market
 * leaders: the GitHub hook deliveries listing keeps delivery history
 * readable with nothing more than read permission, newest first, capped
 * like a per_page maximum; the GitHub single delivery read includes the
 * payload and the recorded error because they are part of the honest
 * delivery record; unknown filter values are named refusals, never
 * silently ignored filters; and cross-organization or unknown endpoint
 * and delivery ids all answer one uniform 404. Reads never write audit
 * rows, and deleting an endpoint takes its delivery history with it -
 * the same law GitHub and Stripe follow.
 */
suite('GENESIS webhook delivery history flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId: string;
  let foreignOrganizationId: string;
  let liveEndpointId: string;
  let deadEndpointId: string;
  let capEndpointId: string;
  let irisEndpointId: string;
  let liveDeliveryId: string;
  let deadDeliveryId: string;
  let receiver: Server;
  let receiverUrl: string;
  const receiverHits: ReceiverHit[] = [];
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
    const email = 'genesis-whdh-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'delivery-history-password-123',
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
    const endpoint = response.body as { id: string; secret: string };
    expect(endpoint.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    return endpoint.id;
  };

  const dispatch = (token: string, orgId: string, eventName: string, ordinal: number) =>
    api(
      'POST',
      '/organizations/' + orgId + '/webhooks/dispatch',
      {
        eventName,
        payload: { note: 'genesis-whdh-' + runId, ordinal },
      },
      token,
    );

  const listEndpointDeliveries = (
    token: string,
    orgId: string,
    endpointId: string,
    status?: string,
  ) =>
    api(
      'GET',
      '/organizations/' + orgId + '/webhooks/endpoints/' + endpointId
        + '/deliveries' + (status === undefined ? '' : '?status=' + encodeURIComponent(status)),
      undefined,
      token,
    );

  const inspectDelivery = (
    token: string,
    orgId: string,
    endpointId: string,
    deliveryId: string,
  ) =>
    api(
      'GET',
      '/organizations/' + orgId + '/webhooks/endpoints/' + endpointId
        + '/deliveries/' + deliveryId,
      undefined,
      token,
    );

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

  it('seeds two organizations, a local receiver, and four endpoints', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;
    expect(foreignOrganizationId).not.toBe(organizationId);

    receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
        receiverHits.push({ body, receivedAt: Date.now() });
        response.statusCode = 200;
        response.end('ok');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const address = receiver.address() as { port: number };
    receiverUrl = 'http://127.0.0.1:' + address.port;

    const deadHolder = createServer();
    await new Promise<void>((resolve) => deadHolder.listen(0, '127.0.0.1', resolve));
    const deadPort = (deadHolder.address() as { port: number }).port;
    await new Promise<void>((resolve) => deadHolder.close(() => resolve()));
    const deadUrl = 'http://127.0.0.1:' + deadPort + '/nothing';

    liveEndpointId = await createEndpoint(
      hank.tokens.accessToken,
      organizationId,
      receiverUrl + '/live',
      ['application.created'],
    );
    deadEndpointId = await createEndpoint(
      hank.tokens.accessToken,
      organizationId,
      deadUrl,
      ['application.updated'],
    );
    capEndpointId = await createEndpoint(
      hank.tokens.accessToken,
      organizationId,
      receiverUrl + '/cap',
      ['reference.created'],
    );
    irisEndpointId = await createEndpoint(
      iris.tokens.accessToken,
      foreignOrganizationId,
      receiverUrl + '/foreign',
      ['all'],
    );
  });

  it('lists delivered endpoint history newest first with the honest row shape', async () => {
    const first = await dispatch(hank.tokens.accessToken, organizationId, 'application.created', 1);
    expect(first.status).toBe(201);
    expect(first.body.matchedEndpoints).toBe(1);

    const second = await dispatch(hank.tokens.accessToken, organizationId, 'application.created', 2);
    expect(second.status).toBe(201);
    expect(second.body.matchedEndpoints).toBe(1);

    const listed = await listEndpointDeliveries(hank.tokens.accessToken, organizationId, liveEndpointId);
    expect(listed.status).toBe(200);
    const rows = listed.body as unknown as Array<{
      id: string;
      endpointId: string;
      eventName: string;
      status: string;
      attempts: number;
      lastError: string | null;
      deliveredAt: string | null;
      nextAttemptAt: string | null;
      createdAt: string;
    }>;
    expect(rows.length).toBe(2);
    expect(Object.keys(rows[0]).sort()).toEqual([
      'attempts',
      'createdAt',
      'deliveredAt',
      'endpointId',
      'eventName',
      'id',
      'lastError',
      'lastStatusCode',
      'nextAttemptAt',
      'organizationId',
      'status',
    ]);
    expect(rows.every((row) => row.endpointId === liveEndpointId)).toBe(true);
    expect(rows.every((row) => row.eventName === 'application.created')).toBe(true);
    expect(rows.every((row) => row.status === 'DELIVERED')).toBe(true);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    expect(rows.every((row) => row.deliveredAt !== null)).toBe(true);
    expect(rows.every((row) => row.lastError === null)).toBe(true);
    expect(rows.every((row) => row.nextAttemptAt === null)).toBe(true);
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i - 1].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(rows[i].createdAt).getTime(),
      );
    }
    liveDeliveryId = rows[rows.length - 1].id;
    expect(receiverHits.length).toBeGreaterThanOrEqual(2);
  });

  it('records failed deliveries as pending and filters statuses honestly', async () => {
    const failed = await dispatch(hank.tokens.accessToken, organizationId, 'application.updated', 3);
    expect(failed.status).toBe(201);
    expect(failed.body.matchedEndpoints).toBe(1);

    const listed = await listEndpointDeliveries(hank.tokens.accessToken, organizationId, deadEndpointId);
    expect(listed.status).toBe(200);
    const rows = listed.body as unknown as Array<{
      id: string;
      status: string;
      attempts: number;
      lastError: string | null;
      nextAttemptAt: string | null;
    }>;
    expect(rows.length).toBe(1);
    expect(rows.every((row) => row.status === 'PENDING')).toBe(true);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    expect(rows.every((row) => row.lastError !== null)).toBe(true);
    expect(rows.every((row) => row.nextAttemptAt !== null)).toBe(true);
    deadDeliveryId = rows[0].id;

    const pending = await listEndpointDeliveries(
      hank.tokens.accessToken, organizationId, deadEndpointId, 'PENDING',
    );
    expect(pending.status).toBe(200);
    expect((pending.body as unknown as Array<{ status: string }>).every((row) => row.status === 'PENDING')).toBe(true);
    expect((pending.body as unknown as Array<unknown>).length).toBe(1);

    const delivered = await listEndpointDeliveries(
      hank.tokens.accessToken, organizationId, deadEndpointId, 'DELIVERED',
    );
    expect(delivered.status).toBe(200);
    expect(delivered.body).toEqual([]);

    const exhausted = await listEndpointDeliveries(
      hank.tokens.accessToken, organizationId, deadEndpointId, 'EXHAUSTED',
    );
    expect(exhausted.status).toBe(200);
    expect(exhausted.body).toEqual([]);

    const liveDelivered = await listEndpointDeliveries(
      hank.tokens.accessToken, organizationId, liveEndpointId, 'DELIVERED',
    );
    expect(liveDelivered.status).toBe(200);
    expect((liveDelivered.body as unknown as Array<unknown>).length).toBe(2);

    const unknown = await listEndpointDeliveries(
      hank.tokens.accessToken, organizationId, deadEndpointId, 'bogus',
    );
    expect(unknown.status).toBe(400);
    expect((unknown.body as { message: string }).message).toMatch(/^Unknown delivery status/);

    const caseMangled = await listEndpointDeliveries(
      hank.tokens.accessToken, organizationId, deadEndpointId, 'delivered',
    );
    expect(caseMangled.status).toBe(400);
    expect((caseMangled.body as { message: string }).message).toMatch(/^Unknown delivery status/);

    const padded = await listEndpointDeliveries(
      hank.tokens.accessToken, organizationId, deadEndpointId, ' DELIVERED ',
    );
    expect(padded.status).toBe(400);
    expect((padded.body as { message: string }).message).toMatch(/^Unknown delivery status/);
  });

  it('inspects a single delivery with its payload and its recorded error', async () => {
    const inspected = await inspectDelivery(
      hank.tokens.accessToken, organizationId, liveEndpointId, liveDeliveryId,
    );
    expect(inspected.status).toBe(200);
    const row = inspected.body as {
      payload: Record<string, unknown>;
      deliveredAt: string | null;
      lastError: string | null;
      status: string;
    };
    expect(row.status).toBe('DELIVERED');
    expect(row.deliveredAt).not.toBe(null);
    expect(row.lastError).toBe(null);
    expect(row.payload).toEqual({ note: 'genesis-whdh-' + runId, ordinal: 1 });

    const deadInspected = await inspectDelivery(
      hank.tokens.accessToken, organizationId, deadEndpointId, deadDeliveryId,
    );
    expect(deadInspected.status).toBe(200);
    const deadRow = deadInspected.body as {
      payload: Record<string, unknown>;
      deliveredAt: string | null;
      lastError: string | null;
      status: string;
    };
    expect(deadRow.status).toBe('PENDING');
    expect(deadRow.deliveredAt).toBe(null);
    expect(deadRow.lastError).not.toBe(null);
    expect(deadRow.payload).toEqual({ note: 'genesis-whdh-' + runId, ordinal: 3 });
  });

  it('answers one uniform 404 for unknown and cross-endpoint delivery probes', async () => {
    const messages = new Set<string>();

    const unknownId = await inspectDelivery(
      hank.tokens.accessToken, organizationId, liveEndpointId, 'does-not-exist-at-all',
    );
    expect(unknownId.status).toBe(404);
    messages.add((unknownId.body as { message: string }).message);

    const crossEndpoint = await inspectDelivery(
      hank.tokens.accessToken, organizationId, capEndpointId, liveDeliveryId,
    );
    expect(crossEndpoint.status).toBe(404);
    messages.add((crossEndpoint.body as { message: string }).message);

    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Webhook delivery not found.');
  });

  it('tenant-bounds endpoint delivery reads behind one uniform 404', async () => {
    const messages = new Set<string>();

    const foreignList = await listEndpointDeliveries(
      hank.tokens.accessToken, organizationId, irisEndpointId,
    );
    expect(foreignList.status).toBe(404);
    messages.add((foreignList.body as { message: string }).message);

    const foreignInspect = await inspectDelivery(
      hank.tokens.accessToken, organizationId, irisEndpointId, 'does-not-exist-at-all',
    );
    expect(foreignInspect.status).toBe(404);
    messages.add((foreignInspect.body as { message: string }).message);

    const unknownList = await listEndpointDeliveries(
      hank.tokens.accessToken, organizationId, 'does-not-exist-at-all',
    );
    expect(unknownList.status).toBe(404);
    messages.add((unknownList.body as { message: string }).message);

    const unknownInspect = await inspectDelivery(
      hank.tokens.accessToken, organizationId, 'does-not-exist-at-all', 'does-not-exist-at-all',
    );
    expect(unknownInspect.status).toBe(404);
    messages.add((unknownInspect.body as { message: string }).message);

    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Webhook endpoint not found.');

    const irisOwn = await listEndpointDeliveries(
      iris.tokens.accessToken, foreignOrganizationId, irisEndpointId,
    );
    expect(irisOwn.status).toBe(200);
    expect(irisOwn.body).toEqual([]);
  });

  it('answers identical bodies to double-tapped list reads', async () => {
    const raced = await Promise.all([
      listEndpointDeliveries(hank.tokens.accessToken, organizationId, liveEndpointId),
      listEndpointDeliveries(hank.tokens.accessToken, organizationId, liveEndpointId),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(200);
    expect(raced[0].body).toEqual(raced[1].body);
  });

  it('races a list against a dispatch into clean outcomes only', async () => {
    const raced = await Promise.all([
      listEndpointDeliveries(hank.tokens.accessToken, organizationId, liveEndpointId),
      dispatch(hank.tokens.accessToken, organizationId, 'application.created', 4),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(201);

    const deliveries = (raced[1].body as {
      deliveries: Array<{ deliveryId: string; endpointId: string; status: string }>;
    }).deliveries;
    const liveRow = deliveries.find((row) => row.endpointId === liveEndpointId)!;
    expect(liveRow.status).toBe('DELIVERED');

    const finalList = await listEndpointDeliveries(hank.tokens.accessToken, organizationId, liveEndpointId);
    expect(finalList.status).toBe(200);
    const ids = (finalList.body as unknown as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toContain(liveRow.deliveryId);
    expect(ids.length).toBe(3);
  });

  it('caps endpoint history at one hundred rows against database truth', async () => {
    const now = Date.now();
    await prisma.webhookDelivery.createMany({
      data: Array.from({ length: 105 }, (_, idx) => ({
        endpointId: capEndpointId,
        organizationId,
        eventName: 'reference.created',
        payload: { seeded: idx },
        status: 'EXHAUSTED',
        attempts: 5,
        lastStatusCode: 500,
        lastError: 'seeded exhausted row',
        deliveredAt: null,
        nextAttemptAt: null,
        createdAt: new Date(now - (105 - idx) * 1000),
      })),
    });

    const storedCount = await prisma.webhookDelivery.count({ where: { endpointId: capEndpointId } });
    expect(storedCount).toBe(105);

    const truthRows = await prisma.webhookDelivery.findMany({
      where: { endpointId: capEndpointId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, createdAt: true },
    });
    expect(truthRows.length).toBe(100);

    const listed = await listEndpointDeliveries(hank.tokens.accessToken, organizationId, capEndpointId);
    expect(listed.status).toBe(200);
    const rows = listed.body as unknown as Array<{ id: string; createdAt: string; status: string }>;
    expect(rows.length).toBe(100);
    expect(rows.map((row) => row.id)).toEqual(truthRows.map((row) => row.id));
    expect(rows.every((row) => row.status === 'EXHAUSTED')).toBe(true);
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i - 1].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(rows[i].createdAt).getTime(),
      );
    }
  });

  it('hides history with the endpoint when the endpoint is deleted', async () => {
    const removed = await api(
      'DELETE',
      '/organizations/' + organizationId + '/webhooks/endpoints/' + deadEndpointId,
      undefined,
      hank.tokens.accessToken,
    );
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ deleted: true, endpointId: deadEndpointId });

    const listed = await listEndpointDeliveries(hank.tokens.accessToken, organizationId, deadEndpointId);
    expect(listed.status).toBe(404);
    expect((listed.body as { message: string }).message).toBe('Webhook endpoint not found.');

    const inspected = await inspectDelivery(
      hank.tokens.accessToken, organizationId, deadEndpointId, deadDeliveryId,
    );
    expect(inspected.status).toBe(404);
    expect((inspected.body as { message: string }).message).toBe('Webhook endpoint not found.');

    const cascaded = await prisma.webhookDelivery.count({ where: { endpointId: deadEndpointId } });
    expect(cascaded).toBe(0);
  });

  it('writes zero audit rows for endpoint delivery reads', async () => {
    const before = await prisma.auditEvent.count({ where: { organizationId } });

    const listed = await listEndpointDeliveries(hank.tokens.accessToken, organizationId, liveEndpointId);
    expect(listed.status).toBe(200);

    const filtered = await listEndpointDeliveries(
      hank.tokens.accessToken, organizationId, liveEndpointId, 'DELIVERED',
    );
    expect(filtered.status).toBe(200);

    const inspected = await inspectDelivery(
      hank.tokens.accessToken, organizationId, liveEndpointId, liveDeliveryId,
    );
    expect(inspected.status).toBe(200);

    const capListed = await listEndpointDeliveries(hank.tokens.accessToken, organizationId, capEndpointId);
    expect(capListed.status).toBe(200);

    const after = await prisma.auditEvent.count({ where: { organizationId } });
    expect(after).toBe(before);
  });
});
