import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { createServer, Server } from 'node:http';
import { SIGNATURE_HEADER, signPayload } from '../integrations/engine/webhook-signature.engine';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

const hasDatabase = typeof process.env.DATABASE_URL === 'string'
  && process.env.DATABASE_URL.startsWith('postgres');
const hasJwtSecret = typeof process.env.JWT_ACCESS_SECRET === 'string'
  && process.env.JWT_ACCESS_SECRET.length >= 32;
const suite = hasDatabase && hasJwtSecret ? describe : describe.skip;

interface TokenPair { accessToken: string; refreshToken: string; }
interface UserContext { email: string; tokens: TokenPair; userId: string; }
interface ApiResponse { status: number; body: Record<string, unknown>; }
interface ReceiverHit {
  url: string;
  rawBody: string;
  body: Record<string, unknown>;
  signature: string;
  receivedAt: number;
}

/**
 * Webhook ping flows against the real app and the real CI PostgreSQL.
 * Grounded in the market leaders: the GitHub org webhook ping
 * (POST /orgs/{org}/hooks/{hook_id}/pings behind the Webhooks write
 * permission) pushes one ping event to the endpoint as a
 * confirmation that it is configured and reachable, and the ping
 * event is GitHub is own confirmation-of-configuration event. A
 * ping is a health check, not a real event, so it goes to the
 * named endpoint regardless of subscriptions and regardless of
 * the active flag. Every landed ping creates exactly one honest
 * delivery row with one signed attempt, answers with the same
 * attempt shape as dispatch and retry, and writes exactly one
 * audit row. Unknown, foreign, and concurrently deleted endpoints
 * answer one uniform 404, and non-admin members are refused by the
 * same role gate the other endpoint mutations use.
 */
suite('GENESIS webhook ping flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let hank: UserContext;
  let iris: UserContext;
  let dana: UserContext;
  let earl: UserContext;
  let organizationId: string;
  let foreignOrganizationId: string;
  let primaryEndpointId: string;
  let primarySecret: string;
  let deadEndpointId: string;
  let racedEndpointId: string;
  let irisEndpointId: string;
  let receiver: Server;
  let receiverUrl: string;
  let deadUrl: string;
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
    const email = 'genesis-whpg-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'webhook-ping-password-123',
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
    return { id: endpoint.id, secret: endpoint.secret };
  };

  const pingEndpoint = (token: string, orgId: string, endpointId: string) =>
    api(
      'POST',
      '/organizations/' + orgId + '/webhooks/endpoints/' + endpointId + '/ping',
      {},
      token,
    );

  const endpointHistory = (token: string, orgId: string, endpointId: string) =>
    api(
      'GET',
      '/organizations/' + orgId + '/webhooks/endpoints/' + endpointId + '/deliveries',
      undefined,
      token,
    );

  const pingAuditCount = (endpointId: string) =>
    prisma.auditEvent.count({
      where: {
        organizationId,
        action: 'webhook.endpoint.ping',
        metadata: { path: ['endpointId'], equals: endpointId },
      },
    });

  const hitsFor = (url: string) => receiverHits.filter((hit) => hit.url === url);

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

  it('seeds two organizations, roles, a receiver, and a dead port', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;
    expect(foreignOrganizationId).not.toBe(organizationId);

    dana = await registerUser('dana');
    const addDeveloper = await api(
      'POST',
      '/organizations/' + organizationId + '/members',
      { email: dana.email, role: 'DEVELOPER' },
      hank.tokens.accessToken,
    );
    expect(addDeveloper.status).toBe(201);

    earl = await registerUser('earl');
    const addAdmin = await api(
      'POST',
      '/organizations/' + organizationId + '/members',
      { email: earl.email, role: 'ADMIN' },
      hank.tokens.accessToken,
    );
    expect(addAdmin.status).toBe(201);

    receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          body = {};
        }
        const headers = request.headers as Record<string, string | string[] | undefined>;
        let signature = '';
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === SIGNATURE_HEADER.toLowerCase()) {
            const value = headers[key];
            signature = Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
          }
        }
        receiverHits.push({
          url: request.url ?? '',
          rawBody,
          body,
          signature,
          receivedAt: Date.now(),
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

    const primary = await createEndpoint(
      hank.tokens.accessToken,
      organizationId,
      receiverUrl + '/primary',
      ['application.created'],
    );
    primaryEndpointId = primary.id;
    primarySecret = primary.secret;

    const dead = await createEndpoint(
      hank.tokens.accessToken,
      organizationId,
      deadUrl,
      ['application.created'],
    );
    deadEndpointId = dead.id;

    const raced = await createEndpoint(
      hank.tokens.accessToken,
      organizationId,
      receiverUrl + '/raced',
      ['reference.created'],
    );
    racedEndpointId = raced.id;

    const foreign = await createEndpoint(
      iris.tokens.accessToken,
      foreignOrganizationId,
      receiverUrl + '/foreign',
      ['all'],
    );
    irisEndpointId = foreign.id;
  });

  it('lands one signed ping delivery with the honest attempt shape', async () => {
    const pinged = await pingEndpoint(hank.tokens.accessToken, organizationId, primaryEndpointId);
    expect(pinged.status).toBe(201);
    expect(Object.keys(pinged.body).sort()).toEqual([
      'attempts',
      'deliveryId',
      'endpointId',
      'lastError',
      'lastStatusCode',
      'status',
    ]);
    expect(pinged.body.status).toBe('DELIVERED');
    expect(pinged.body.attempts).toBe(1);
    expect(pinged.body.lastStatusCode).toBe(200);
    expect(pinged.body.lastError).toBeNull();
    expect(pinged.body.endpointId).toBe(primaryEndpointId);

    const hits = hitsFor('/primary');
    expect(hits.length).toBe(1);
    const hit = hits[0];
    expect(hit.body.event).toBe('ping');
    expect(hit.body.deliveryId).toBe(pinged.body.deliveryId);
    expect(typeof hit.body.sentAt).toBe('string');
    const payload = hit.body.payload as Record<string, unknown>;
    expect(payload.endpointId).toBe(primaryEndpointId);
    expect(payload.url).toBe(receiverUrl + '/primary');
    expect(payload.eventSubscriptions).toEqual(['application.created']);
    expect(payload.active).toBe(true);

    expect(hit.signature).not.toBe('');
    const parts = hit.signature.split(',');
    expect(parts.length).toBe(2);
    let timestamp = '';
    for (const part of parts) {
      if (part.indexOf('t=') === 0) timestamp = part.slice(2);
    }
    expect(timestamp).not.toBe('');
    const recomputed = signPayload(primarySecret, Number(timestamp), hit.rawBody);
    expect(recomputed).toBe(hit.signature);
  });

  it('records the ping in endpoint history with exactly one audit row', async () => {
    const pinged = await pingEndpoint(hank.tokens.accessToken, organizationId, primaryEndpointId);
    expect(pinged.status).toBe(201);
    const deliveryId = pinged.body.deliveryId as string;

    const history = await endpointHistory(hank.tokens.accessToken, organizationId, primaryEndpointId);
    expect(history.status).toBe(200);
    const rows = history.body as unknown as Array<{
      id: string;
      eventName: string;
      status: string;
      attempts: number;
      lastStatusCode: number | null;
    }>;
    expect(rows.length).toBe(2);
    expect(rows[0].id).toBe(deliveryId);
    expect(rows[0].eventName).toBe('ping');
    expect(rows[0].status).toBe('DELIVERED');
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].lastStatusCode).toBe(200);

    const auditRows = await prisma.auditEvent.findMany({
      where: { organizationId, action: 'webhook.endpoint.ping', resourceId: deliveryId },
    });
    expect(auditRows.length).toBe(1);
    const metadata = auditRows[0].metadata as Record<string, unknown>;
    expect(metadata.endpointId).toBe(primaryEndpointId);
    expect(metadata.status).toBe('DELIVERED');
    expect(metadata.attempts).toBe(1);
  });

  it('ignores subscriptions: ping reaches an endpoint that never subscribed to ping', async () => {
    const dispatched = await api(
      'POST',
      '/organizations/' + organizationId + '/webhooks/dispatch',
      { eventName: 'application.created', payload: { note: 'genesis-whpg-' + runId } },
      hank.tokens.accessToken,
    );
    expect(dispatched.status).toBe(201);
    expect(dispatched.body.matchedEndpoints).toBe(1);

    const pinged = await pingEndpoint(hank.tokens.accessToken, organizationId, primaryEndpointId);
    expect(pinged.status).toBe(201);

    const pingHits = hitsFor('/primary').filter((hit) => hit.body.event === 'ping');
    const dispatchHits = hitsFor('/primary').filter((hit) => hit.body.event === 'application.created');
    expect(pingHits.length).toBe(3);
    expect(dispatchHits.length).toBe(1);

    const history = await endpointHistory(hank.tokens.accessToken, organizationId, primaryEndpointId);
    const names = (history.body as unknown as Array<{ eventName: string }>).map((row) => row.eventName);
    expect(names.filter((name) => name === 'ping').length).toBe(3);
    expect(names.filter((name) => name === 'application.created').length).toBe(1);
  });

  it('pings an inactive endpoint because a health check is not a subscription match', async () => {
    const off = await api(
      'PATCH',
      '/organizations/' + organizationId + '/webhooks/endpoints/' + primaryEndpointId,
      { active: false },
      hank.tokens.accessToken,
    );
    expect(off.status).toBe(200);
    expect((off.body as { active: boolean }).active).toBe(false);

    const pinged = await pingEndpoint(hank.tokens.accessToken, organizationId, primaryEndpointId);
    expect(pinged.status).toBe(201);
    expect(pinged.body.status).toBe('DELIVERED');

    const hits = hitsFor('/primary').filter((hit) => hit.body.event === 'ping');
    expect(hits.length).toBe(4);
    const payload = hits[hits.length - 1].body.payload as Record<string, unknown>;
    expect(payload.active).toBe(false);

    const on = await api(
      'PATCH',
      '/organizations/' + organizationId + '/webhooks/endpoints/' + primaryEndpointId,
      { active: true },
      hank.tokens.accessToken,
    );
    expect(on.status).toBe(200);
    expect((on.body as { active: boolean }).active).toBe(true);
  });

  it('records an honest pending failure with the backoff holding a retry', async () => {
    const pinged = await pingEndpoint(hank.tokens.accessToken, organizationId, deadEndpointId);
    expect(pinged.status).toBe(201);
    expect(pinged.body.status).toBe('PENDING');
    expect(pinged.body.attempts).toBe(1);
    expect(pinged.body.lastStatusCode).toBeNull();
    expect(typeof pinged.body.lastError).toBe('string');
    expect(String(pinged.body.lastError)).toContain('ECONNREFUSED');

    const history = await endpointHistory(hank.tokens.accessToken, organizationId, deadEndpointId);
    expect(history.status).toBe(200);
    const rows = history.body as unknown as Array<{
      id: string;
      status: string;
      attempts: number;
      nextAttemptAt: string | null;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(pinged.body.deliveryId);
    expect(rows[0].status).toBe('PENDING');
    expect(rows[0].nextAttemptAt).not.toBeNull();

    const auditRows = await prisma.auditEvent.count({
      where: { organizationId, action: 'webhook.endpoint.ping', resourceId: pinged.body.deliveryId as string },
    });
    expect(auditRows).toBe(1);

    const retry = await api(
      'POST',
      '/organizations/' + organizationId + '/webhooks/deliveries/' + String(pinged.body.deliveryId) + '/retry',
      {},
      hank.tokens.accessToken,
    );
    expect(retry.status).toBe(409);
    expect((retry.body as { message: string }).message).toBe('Retry is not due yet.');
  });

  it('tenant-bounds pings behind one uniform 404 while the foreign owner still pings her own', async () => {
    const before = await pingAuditCount(primaryEndpointId);
    const messages = new Set<string>();

    const unknown = await pingEndpoint(hank.tokens.accessToken, organizationId, 'does-not-exist-at-all');
    expect(unknown.status).toBe(404);
    messages.add((unknown.body as { message: string }).message);

    const foreign = await pingEndpoint(hank.tokens.accessToken, organizationId, irisEndpointId);
    expect(foreign.status).toBe(404);
    messages.add((foreign.body as { message: string }).message);

    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Webhook endpoint not found.');

    const own = await pingEndpoint(iris.tokens.accessToken, foreignOrganizationId, irisEndpointId);
    expect(own.status).toBe(201);
    expect(own.body.status).toBe('DELIVERED');
    expect(hitsFor('/foreign').filter((hit) => hit.body.event === 'ping').length).toBe(1);

    const after = await pingAuditCount(primaryEndpointId);
    expect(after).toBe(before);
  });

  it('refuses non-admin members with the role gate and zero audit rows', async () => {
    const before = await pingAuditCount(primaryEndpointId);

    const reads = await endpointHistory(dana.tokens.accessToken, organizationId, primaryEndpointId);
    expect(reads.status).toBe(200);

    const refused = await pingEndpoint(dana.tokens.accessToken, organizationId, primaryEndpointId);
    expect(refused.status).toBe(404);
    expect((refused.body as { message: string }).message).toBe('Organization not found.');

    const after = await pingAuditCount(primaryEndpointId);
    expect(after).toBe(before);
  });

  it('lands a double-tapped ping as two honest deliveries', async () => {
    const before = await pingAuditCount(primaryEndpointId);
    const raced = await Promise.all([
      pingEndpoint(hank.tokens.accessToken, organizationId, primaryEndpointId),
      pingEndpoint(hank.tokens.accessToken, organizationId, primaryEndpointId),
    ]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(201);
    expect(raced[0].body.deliveryId).not.toBe(raced[1].body.deliveryId);
    expect(raced[0].body.status).toBe('DELIVERED');
    expect(raced[1].body.status).toBe('DELIVERED');

    const stored = await prisma.webhookDelivery.count({
      where: { endpointId: primaryEndpointId, eventName: 'ping' },
    });
    expect(stored).toBe(6);

    const hits = hitsFor('/primary').filter((hit) => hit.body.event === 'ping');
    expect(hits.length).toBe(6);

    const after = await pingAuditCount(primaryEndpointId);
    expect(after).toBe(before + 2);
  });

  it('ends a ping racing a delete cleanly whichever way it lands', async () => {
    const raced = await Promise.all([
      pingEndpoint(hank.tokens.accessToken, organizationId, racedEndpointId),
      api(
        'DELETE',
        '/organizations/' + organizationId + '/webhooks/endpoints/' + racedEndpointId,
        undefined,
        hank.tokens.accessToken,
      ),
    ]);
    const pingOutcome = raced[0];
    const deleteOutcome = raced[1];
    expect([201, 404]).toContain(pingOutcome.status);
    expect(deleteOutcome.status).toBe(200);

    const endpointRows = await prisma.webhookEndpoint.count({ where: { id: racedEndpointId } });
    expect(endpointRows).toBe(0);
    const deliveryRows = await prisma.webhookDelivery.count({ where: { endpointId: racedEndpointId } });
    expect(deliveryRows).toBe(0);

    const deleteAudit = await prisma.auditEvent.count({
      where: { organizationId, action: 'webhook.endpoint.delete', resourceId: racedEndpointId },
    });
    expect(deleteAudit).toBe(1);

    const pingAuditForRaced = await prisma.auditEvent.count({
      where: {
        organizationId,
        action: 'webhook.endpoint.ping',
        metadata: { path: ['endpointId'], equals: racedEndpointId },
      },
    });
    expect(pingAuditForRaced).toBe(pingOutcome.status === 201 ? 1 : 0);

    const ghost = await pingEndpoint(hank.tokens.accessToken, organizationId, racedEndpointId);
    expect(ghost.status).toBe(404);
    expect((ghost.body as { message: string }).message).toBe('Webhook endpoint not found.');
  });

  it('merges two admins racing pings into two honest deliveries', async () => {
    const before = await pingAuditCount(primaryEndpointId);
    const raced = await Promise.all([
      pingEndpoint(hank.tokens.accessToken, organizationId, primaryEndpointId),
      pingEndpoint(earl.tokens.accessToken, organizationId, primaryEndpointId),
    ]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(201);
    expect(raced[0].body.deliveryId).not.toBe(raced[1].body.deliveryId);

    const after = await pingAuditCount(primaryEndpointId);
    expect(after).toBe(before + 2);
  });

  it('writes zero ping audit rows for reads', async () => {
    const before = await pingAuditCount(primaryEndpointId);

    const listed = await api(
      'GET',
      '/organizations/' + organizationId + '/webhooks/deliveries',
      undefined,
      dana.tokens.accessToken,
    );
    expect(listed.status).toBe(200);

    const history = await endpointHistory(hank.tokens.accessToken, organizationId, primaryEndpointId);
    expect(history.status).toBe(200);

    const after = await pingAuditCount(primaryEndpointId);
    expect(after).toBe(before);
  });
});
