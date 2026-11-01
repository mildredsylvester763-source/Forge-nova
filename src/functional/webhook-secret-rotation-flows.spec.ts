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
}

/**
 * Webhook signing-secret rotation flows against the real app and the
 * real CI PostgreSQL. Grounded in the market leaders: GitHub rotates
 * a webhook secret through the update config.secret surface, and the
 * industry pattern for reveal-once secret stores is a dedicated
 * rotate route that hands back the raw secret exactly once while
 * every other surface stays secret-blind. GENESIS keeps the PATCH
 * blind to the secret by design, so the rotate route is the only
 * surface that can ever reveal a secret again: the previous secret
 * is invalidated immediately, with no Stripe-style dual-signing
 * overlap window. Every landed rotation writes exactly one audit
 * row, reads and refusals write none, unknown, foreign, and
 * concurrently deleted endpoints answer one uniform 404, and
 * rotations racing each other or racing a delete all end in one
 * clean way.
 */
suite('GENESIS webhook secret rotation flows (real app, real database)', () => {
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
  let originalPrimarySecret: string;
  let rotatedPrimarySecret: string;
  let racedEndpointId: string;
  let irisEndpointId: string;
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
    const email = 'genesis-whsr-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'webhook-rotation-password-123',
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

  const rotateEndpoint = (token: string, orgId: string, endpointId: string) =>
    api(
      'POST',
      '/organizations/' + orgId + '/webhooks/endpoints/' + endpointId + '/rotate-secret',
      {},
      token,
    );

  const deleteEndpoint = (token: string, orgId: string, endpointId: string) =>
    api(
      'DELETE',
      '/organizations/' + orgId + '/webhooks/endpoints/' + endpointId,
      undefined,
      token,
    );

  const rotateAuditCount = (endpointId: string) =>
    prisma.auditEvent.count({
      where: {
        organizationId,
        action: 'webhook.endpoint.rotate_secret',
        resourceId: endpointId,
      },
    });

  const storedPrimarySecret = async () => {
    const row = await prisma.webhookEndpoint.findUnique({
      where: { id: primaryEndpointId },
      select: { secret: true },
    });
    return row?.secret ?? '';
  };

  const signatureTimestamp = (signature: string) => {
    const parts = signature.split(',');
    for (const part of parts) {
      if (part.indexOf('t=') === 0) return Number(part.slice(2));
    }
    return 0;
  };

  const verifiesWith = (secret: string, hit: ReceiverHit) =>
    signPayload(secret, signatureTimestamp(hit.signature), hit.rawBody) === hit.signature;

  const hitsFor = (url: string) => receiverHits.filter((hit) => hit.url === url);

  const dispatchCreated = (token: string) =>
    api(
      'POST',
      '/organizations/' + organizationId + '/webhooks/dispatch',
      { eventName: 'application.created', payload: { note: 'genesis-whsr-' + runId } },
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

  it('seeds two organizations, roles, a receiver, and endpoints', async () => {
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
        });
        response.statusCode = 200;
        response.end('ok');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const address = receiver.address() as { port: number };
    receiverUrl = 'http://127.0.0.1:' + address.port;

    const primary = await createEndpoint(
      hank.tokens.accessToken,
      organizationId,
      receiverUrl + '/primary',
      ['application.created'],
    );
    primaryEndpointId = primary.id;
    originalPrimarySecret = primary.secret;

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

  it('reveals a fresh signing secret exactly once per landed rotation', async () => {
    const before = await rotateAuditCount(primaryEndpointId);
    const rotated = await rotateEndpoint(hank.tokens.accessToken, organizationId, primaryEndpointId);
    expect(rotated.status).toBe(201);
    const secret = rotated.body.secret as string;
    expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(secret).not.toBe(originalPrimarySecret);
    expect(rotated.body.id).toBe(primaryEndpointId);
    expect(Object.keys(rotated.body).sort()).toEqual([
      'active',
      'createdAt',
      'eventSubscriptions',
      'id',
      'lastFailureAt',
      'lastSuccessAt',
      'organizationId',
      'secret',
      'updatedAt',
      'url',
    ]);
    rotatedPrimarySecret = secret;
    expect(await rotateAuditCount(primaryEndpointId)).toBe(before + 1);
  });

  it('keeps every read surface blind to the secret before and after rotation', async () => {
    const before = await rotateAuditCount(primaryEndpointId);

    const listed = await api(
      'GET',
      '/organizations/' + organizationId + '/webhooks/endpoints',
      undefined,
      dana.tokens.accessToken,
    );
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body).indexOf('whsec_')).toBe(-1);

    const history = await api(
      'GET',
      '/organizations/' + organizationId + '/webhooks/endpoints/' + primaryEndpointId + '/deliveries',
      undefined,
      hank.tokens.accessToken,
    );
    expect(history.status).toBe(200);
    expect(JSON.stringify(history.body).indexOf('whsec_')).toBe(-1);

    const deliveries = await api(
      'GET',
      '/organizations/' + organizationId + '/webhooks/deliveries',
      undefined,
      dana.tokens.accessToken,
    );
    expect(deliveries.status).toBe(200);
    expect(JSON.stringify(deliveries.body).indexOf('whsec_')).toBe(-1);

    expect(await rotateAuditCount(primaryEndpointId)).toBe(before);
  });

  it('invalidates the previous secret immediately after the rotation', async () => {
    const dispatched = await dispatchCreated(hank.tokens.accessToken);
    expect(dispatched.status).toBe(201);
    expect(dispatched.body.matchedEndpoints).toBe(1);

    const hits = hitsFor('/primary').filter((hit) => hit.body.event === 'application.created');
    expect(hits.length).toBe(1);
    expect(verifiesWith(rotatedPrimarySecret, hits[0])).toBe(true);
    expect(verifiesWith(originalPrimarySecret, hits[0])).toBe(false);
  });

  it('tenant-bounds rotations behind one uniform 404 while the foreign owner still rotates her own', async () => {
    const before = await rotateAuditCount(primaryEndpointId);
    const messages = new Set<string>();

    const unknown = await rotateEndpoint(hank.tokens.accessToken, organizationId, 'does-not-exist-at-all');
    expect(unknown.status).toBe(404);
    messages.add((unknown.body as { message: string }).message);

    const foreign = await rotateEndpoint(hank.tokens.accessToken, organizationId, irisEndpointId);
    expect(foreign.status).toBe(404);
    messages.add((foreign.body as { message: string }).message);

    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Webhook endpoint not found.');

    const own = await rotateEndpoint(iris.tokens.accessToken, foreignOrganizationId, irisEndpointId);
    expect(own.status).toBe(201);
    expect(own.body.secret as string).toMatch(/^whsec_[0-9a-f]{48}$/);

    expect(await rotateAuditCount(primaryEndpointId)).toBe(before);
  });

  it('refuses non-admin members with the role gate and zero audit rows', async () => {
    const before = await rotateAuditCount(primaryEndpointId);

    const refused = await rotateEndpoint(dana.tokens.accessToken, organizationId, primaryEndpointId);
    expect(refused.status).toBe(404);
    expect((refused.body as { message: string }).message).toBe('Organization not found.');

    expect(await rotateAuditCount(primaryEndpointId)).toBe(before);
  });

  it('lands a double-tapped rotation as two honest rotations with the last secret winning', async () => {
    const before = await rotateAuditCount(primaryEndpointId);

    const first = await rotateEndpoint(hank.tokens.accessToken, organizationId, primaryEndpointId);
    expect(first.status).toBe(201);
    const firstSecret = first.body.secret as string;
    expect(firstSecret).toMatch(/^whsec_[0-9a-f]{48}$/);

    const second = await rotateEndpoint(hank.tokens.accessToken, organizationId, primaryEndpointId);
    expect(second.status).toBe(201);
    const secondSecret = second.body.secret as string;
    expect(secondSecret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(secondSecret).not.toBe(firstSecret);

    expect(await rotateAuditCount(primaryEndpointId)).toBe(before + 2);

    const dispatched = await dispatchCreated(hank.tokens.accessToken);
    expect(dispatched.status).toBe(201);
    const deliveries = dispatched.body.deliveries as unknown as Array<{ deliveryId: string }>;
    expect(deliveries.length).toBe(1);
    const lastHit = hitsFor('/primary').find((hit) => hit.body.deliveryId === deliveries[0].deliveryId);
    expect(lastHit).toBeDefined();
    expect(verifiesWith(secondSecret, lastHit!)).toBe(true);
    expect(verifiesWith(firstSecret, lastHit!)).toBe(false);

    rotatedPrimarySecret = secondSecret;
  });

  it('merges two admins racing rotations with exactly one stored winner', async () => {
    const before = await rotateAuditCount(primaryEndpointId);

    const raced = await Promise.all([
      rotateEndpoint(hank.tokens.accessToken, organizationId, primaryEndpointId),
      rotateEndpoint(earl.tokens.accessToken, organizationId, primaryEndpointId),
    ]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(201);
    const secretA = raced[0].body.secret as string;
    const secretB = raced[1].body.secret as string;
    expect(secretA).not.toBe(secretB);

    expect(await rotateAuditCount(primaryEndpointId)).toBe(before + 2);

    const stored = await storedPrimarySecret();
    expect([secretA, secretB]).toContain(stored);

    const dispatched = await dispatchCreated(hank.tokens.accessToken);
    expect(dispatched.status).toBe(201);
    const deliveries = dispatched.body.deliveries as unknown as Array<{ deliveryId: string }>;
    const lastHit = hitsFor('/primary').find((hit) => hit.body.deliveryId === deliveries[0].deliveryId);
    expect(verifiesWith(stored, lastHit!)).toBe(true);
    const loser = stored === secretA ? secretB : secretA;
    expect(verifiesWith(loser, lastHit!)).toBe(false);

    rotatedPrimarySecret = stored;
  });

  it('ends a rotation racing a delete cleanly whichever way it lands', async () => {
    const raced = await Promise.all([
      rotateEndpoint(hank.tokens.accessToken, organizationId, racedEndpointId),
      deleteEndpoint(hank.tokens.accessToken, organizationId, racedEndpointId),
    ]);
    const rotateOutcome = raced[0];
    const deleteOutcome = raced[1];
    expect([201, 404]).toContain(rotateOutcome.status);
    expect(deleteOutcome.status).toBe(200);

    const endpointRows = await prisma.webhookEndpoint.count({ where: { id: racedEndpointId } });
    expect(endpointRows).toBe(0);

    const deleteAudit = await prisma.auditEvent.count({
      where: { organizationId, action: 'webhook.endpoint.delete', resourceId: racedEndpointId },
    });
    expect(deleteAudit).toBe(1);

    const rotateAuditForRaced = await prisma.auditEvent.count({
      where: {
        organizationId,
        action: 'webhook.endpoint.rotate_secret',
        resourceId: racedEndpointId,
      },
    });
    expect(rotateAuditForRaced).toBe(rotateOutcome.status === 201 ? 1 : 0);

    const ghost = await rotateEndpoint(hank.tokens.accessToken, organizationId, racedEndpointId);
    expect(ghost.status).toBe(404);
    expect((ghost.body as { message: string }).message).toBe('Webhook endpoint not found.');
  });

  it('signs pings with the rotated secret, never the originals', async () => {
    const pinged = await api(
      'POST',
      '/organizations/' + organizationId + '/webhooks/endpoints/' + primaryEndpointId + '/ping',
      {},
      hank.tokens.accessToken,
    );
    expect(pinged.status).toBe(201);
    expect(pinged.body.status).toBe('DELIVERED');

    const pingHits = hitsFor('/primary').filter((hit) => hit.body.event === 'ping');
    expect(pingHits.length).toBe(1);
    const stored = await storedPrimarySecret();
    expect(verifiesWith(stored, pingHits[0])).toBe(true);
    expect(verifiesWith(originalPrimarySecret, pingHits[0])).toBe(false);
    expect(verifiesWith(rotatedPrimarySecret, pingHits[0])).toBe(stored === rotatedPrimarySecret);
  });

  it('keeps the PATCH blind to the secret so rotation stays the only reveal', async () => {
    const before = await rotateAuditCount(primaryEndpointId);

    const attempted = await api(
      'PATCH',
      '/organizations/' + organizationId + '/webhooks/endpoints/' + primaryEndpointId,
      { secret: 'whsec_attacker_guess' },
      hank.tokens.accessToken,
    );
    expect(attempted.status).toBe(400);
    expect(JSON.stringify(attempted.body).indexOf('property secret should not exist')).toBeGreaterThan(-1);

    const noop = await api(
      'PATCH',
      '/organizations/' + organizationId + '/webhooks/endpoints/' + primaryEndpointId,
      {},
      hank.tokens.accessToken,
    );
    expect(noop.status).toBe(200);
    expect(JSON.stringify(noop.body).indexOf('whsec_')).toBe(-1);

    const dispatched = await dispatchCreated(hank.tokens.accessToken);
    expect(dispatched.status).toBe(201);
    const deliveries = dispatched.body.deliveries as unknown as Array<{ deliveryId: string }>;
    const hit = hitsFor('/primary').find((entry) => entry.body.deliveryId === deliveries[0].deliveryId);
    const stored = await storedPrimarySecret();
    expect(verifiesWith(stored, hit!)).toBe(true);
    expect(verifiesWith('whsec_attacker_guess', hit!)).toBe(false);

    expect(await rotateAuditCount(primaryEndpointId)).toBe(before);
  });
});
