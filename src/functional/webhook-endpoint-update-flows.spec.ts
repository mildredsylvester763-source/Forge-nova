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
interface ReceiverHit { url: string; body: Record<string, unknown>; receivedAt: number; }

/**
 * Webhook endpoint partial updates against the real app and the real
 * CI PostgreSQL. Grounded in the market leaders: the GitHub webhook
 * update needs the Webhooks write permission and updates only what is
 * sent, and the Stripe webhook endpoint update is a partial write
 * where only the provided fields change. The signing secret is
 * deliberately not updatable because it was revealed exactly once at
 * creation, an empty body is an honest no-op that writes no audit
 * row, and any provided field lands exactly one audit row per write.
 * Unknown, foreign, and concurrently deleted endpoints answer one
 * uniform 404, and non-admin members are refused by the same role
 * gate the create and delete routes use.
 */
suite('GENESIS webhook endpoint update flows (real app, real database)', () => {
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
  let secondEndpointId: string;
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
    const email = 'genesis-wheu-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'endpoint-update-password-123',
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

  const patchEndpoint = (
    token: string,
    orgId: string,
    endpointId: string,
    body: Record<string, unknown>,
  ) =>
    api(
      'PATCH',
      '/organizations/' + orgId + '/webhooks/endpoints/' + endpointId,
      body,
      token,
    );

  const dispatch = (token: string, orgId: string, eventName: string, ordinal: number) =>
    api(
      'POST',
      '/organizations/' + orgId + '/webhooks/dispatch',
      {
        eventName,
        payload: { note: 'genesis-wheu-' + runId, ordinal },
      },
      token,
    );

  const updateAuditCount = (endpointId: string) =>
    prisma.auditEvent.count({
      where: {
        organizationId,
        action: 'webhook.endpoint.update',
        resourceId: endpointId,
      },
    });

  const listEndpoints = (token: string, orgId: string) =>
    api('GET', '/organizations/' + orgId + '/webhooks/endpoints', undefined, token);

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

  it('seeds two organizations, a local receiver, two endpoints, and role helpers', async () => {
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
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
        receiverHits.push({ url: request.url ?? '', body, receivedAt: Date.now() });
        response.statusCode = 200;
        response.end('ok');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const address = receiver.address() as { port: number };
    receiverUrl = 'http://127.0.0.1:' + address.port;

    primaryEndpointId = await createEndpoint(
      hank.tokens.accessToken,
      organizationId,
      receiverUrl + '/primary',
      ['application.created'],
    );
    secondEndpointId = await createEndpoint(
      hank.tokens.accessToken,
      organizationId,
      receiverUrl + '/second',
      ['reference.created'],
    );
    irisEndpointId = await createEndpoint(
      iris.tokens.accessToken,
      foreignOrganizationId,
      receiverUrl + '/foreign',
      ['all'],
    );
  });

  it('moves the URL with a partial update and keeps everything else untouched', async () => {
    const before = await updateAuditCount(primaryEndpointId);
    const updated = await patchEndpoint(
      hank.tokens.accessToken,
      organizationId,
      primaryEndpointId,
      { url: receiverUrl + '/moved' },
    );
    expect(updated.status).toBe(200);
    const row = updated.body as {
      id: string;
      url: string;
      eventSubscriptions: string[];
      active: boolean;
    };
    expect(Object.keys(updated.body).sort()).toEqual([
      'active',
      'createdAt',
      'eventSubscriptions',
      'id',
      'lastFailureAt',
      'lastSuccessAt',
      'organizationId',
      'updatedAt',
      'url',
    ]);
    expect(row.id).toBe(primaryEndpointId);
    expect(row.url).toBe(receiverUrl + '/moved');
    expect(row.eventSubscriptions).toEqual(['application.created']);
    expect(row.active).toBe(true);

    const after = await updateAuditCount(primaryEndpointId);
    expect(after).toBe(before + 1);

    const delivered = await dispatch(hank.tokens.accessToken, organizationId, 'application.created', 1);
    expect(delivered.status).toBe(201);
    expect(delivered.body.matchedEndpoints).toBe(1);
    expect(
      receiverHits.some((hit) => hit.url === '/moved'),
    ).toBe(true);
  });

  it('rewrites subscriptions, dedupes them, and changes what dispatch matches', async () => {
    const rewritten = await patchEndpoint(
      hank.tokens.accessToken,
      organizationId,
      primaryEndpointId,
      { eventSubscriptions: ['application.updated'] },
    );
    expect(rewritten.status).toBe(200);
    expect((rewritten.body as { eventSubscriptions: string[] }).eventSubscriptions).toEqual(['application.updated']);

    const noMatch = await dispatch(hank.tokens.accessToken, organizationId, 'application.created', 2);
    expect(noMatch.status).toBe(201);
    expect(noMatch.body.matchedEndpoints).toBe(0);

    const nowMatch = await dispatch(hank.tokens.accessToken, organizationId, 'application.updated', 3);
    expect(nowMatch.status).toBe(201);
    expect(nowMatch.body.matchedEndpoints).toBe(1);

    const deduped = await patchEndpoint(
      hank.tokens.accessToken,
      organizationId,
      primaryEndpointId,
      { eventSubscriptions: ['application.created', 'application.created'] },
    );
    expect(deduped.status).toBe(200);
    expect((deduped.body as { eventSubscriptions: string[] }).eventSubscriptions).toEqual(['application.created']);
  });

  it('toggles the endpoint inactive and back like the Stripe disabled flag', async () => {
    const off = await patchEndpoint(
      hank.tokens.accessToken,
      organizationId,
      primaryEndpointId,
      { active: false },
    );
    expect(off.status).toBe(200);
    expect((off.body as { active: boolean }).active).toBe(false);

    const skipped = await dispatch(hank.tokens.accessToken, organizationId, 'application.created', 4);
    expect(skipped.status).toBe(201);
    expect(skipped.body.matchedEndpoints).toBe(0);

    const on = await patchEndpoint(
      hank.tokens.accessToken,
      organizationId,
      primaryEndpointId,
      { active: true },
    );
    expect(on.status).toBe(200);
    expect((on.body as { active: boolean }).active).toBe(true);

    const resumed = await dispatch(hank.tokens.accessToken, organizationId, 'application.created', 5);
    expect(resumed.status).toBe(201);
    expect(resumed.body.matchedEndpoints).toBe(1);
  });

  it('treats an empty body as an honest no-op with zero audit rows', async () => {
    const before = await updateAuditCount(primaryEndpointId);
    const listed = await listEndpoints(hank.tokens.accessToken, organizationId);
    expect(listed.status).toBe(200);
    const current = (listed.body as unknown as Array<{ id: string }>).find((row) => row.id === primaryEndpointId)!;

    const noop = await patchEndpoint(hank.tokens.accessToken, organizationId, primaryEndpointId, {});
    expect(noop.status).toBe(200);
    expect(noop.body).toEqual(current);

    const after = await updateAuditCount(primaryEndpointId);
    expect(after).toBe(before);
  });

  it('refuses malformed updates by name with zero audit rows', async () => {
    const before = await updateAuditCount(primaryEndpointId);

    const badUrl = await patchEndpoint(
      hank.tokens.accessToken, organizationId, primaryEndpointId, { url: 'not-a-url' },
    );
    expect(badUrl.status).toBe(400);
    expect((badUrl.body as { message: string }).message).toBe('Webhook URL must be a valid URL.');

    const badProtocol = await patchEndpoint(
      hank.tokens.accessToken, organizationId, primaryEndpointId, { url: 'ftp://example.com/hook' },
    );
    expect(badProtocol.status).toBe(400);
    expect((badProtocol.body as { message: string }).message).toBe('Webhook URL must use http or https.');

    const badSubscription = await patchEndpoint(
      hank.tokens.accessToken, organizationId, primaryEndpointId, { eventSubscriptions: ['bogus.event'] },
    );
    expect(badSubscription.status).toBe(400);
    expect((badSubscription.body as { message: string }).message).toBe('Invalid event subscription: bogus.event');

    const emptySubscriptions = await patchEndpoint(
      hank.tokens.accessToken, organizationId, primaryEndpointId, { eventSubscriptions: [] },
    );
    expect(emptySubscriptions.status).toBe(400);

    const badActive = await patchEndpoint(
      hank.tokens.accessToken, organizationId, primaryEndpointId, { active: 'yes' },
    );
    expect(badActive.status).toBe(400);

    const unknownField = await patchEndpoint(
      hank.tokens.accessToken, organizationId, primaryEndpointId, { nickname: 'no such field' },
    );
    expect(unknownField.status).toBe(400);

    const after = await updateAuditCount(primaryEndpointId);
    expect(after).toBe(before);
  });

  it('refuses a URL already used by another endpoint with the create conflict', async () => {
    const before = await updateAuditCount(primaryEndpointId);
    const conflict = await patchEndpoint(
      hank.tokens.accessToken,
      organizationId,
      primaryEndpointId,
      { url: receiverUrl + '/second' },
    );
    expect(conflict.status).toBe(409);
    expect((conflict.body as { message: string }).message).toBe('A webhook endpoint with this URL already exists.');

    const listed = await listEndpoints(hank.tokens.accessToken, organizationId);
    expect(listed.status).toBe(200);
    const row = (listed.body as unknown as Array<{ id: string; url: string }>).find((entry) => entry.id === primaryEndpointId)!;
    expect(row.url).not.toBe(receiverUrl + '/second');

    const after = await updateAuditCount(primaryEndpointId);
    expect(after).toBe(before);
  });

  it('tenant-bounds updates behind one uniform 404 while the owner still updates her own', async () => {
    const messages = new Set<string>();

    const unknown = await patchEndpoint(
      hank.tokens.accessToken, organizationId, 'does-not-exist-at-all', { active: false },
    );
    expect(unknown.status).toBe(404);
    messages.add((unknown.body as { message: string }).message);

    const foreign = await patchEndpoint(
      hank.tokens.accessToken, organizationId, irisEndpointId, { active: false },
    );
    expect(foreign.status).toBe(404);
    messages.add((foreign.body as { message: string }).message);

    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Webhook endpoint not found.');

    const own = await patchEndpoint(
      iris.tokens.accessToken, foreignOrganizationId, irisEndpointId, { active: false },
    );
    expect(own.status).toBe(200);
    expect((own.body as { id: string; active: boolean }).id).toBe(irisEndpointId);
    expect((own.body as { active: boolean }).active).toBe(false);
  });

  it('refuses non-admin members with the role gate and zero audit rows', async () => {
    const before = await updateAuditCount(primaryEndpointId);

    const reads = await listEndpoints(dana.tokens.accessToken, organizationId);
    expect(reads.status).toBe(200);

    const refused = await patchEndpoint(
      dana.tokens.accessToken, organizationId, primaryEndpointId, { active: false },
    );
    expect(refused.status).toBe(404);
    expect((refused.body as { message: string }).message).toBe('Organization not found.');

    const after = await updateAuditCount(primaryEndpointId);
    expect(after).toBe(before);
  });

  it('ends an update racing a delete cleanly whichever way it lands', async () => {
    const updateRowsBefore = await updateAuditCount(secondEndpointId);

    const raced = await Promise.all([
      patchEndpoint(hank.tokens.accessToken, organizationId, secondEndpointId, { url: receiverUrl + '/raced-delete' }),
      api('DELETE', '/organizations/' + organizationId + '/webhooks/endpoints/' + secondEndpointId, undefined, hank.tokens.accessToken),
    ]);
    const updateOutcome = raced[0];
    const deleteOutcome = raced[1];
    expect([200, 404]).toContain(updateOutcome.status);
    expect(deleteOutcome.status).toBe(200);

    const stored = await prisma.webhookEndpoint.count({ where: { id: secondEndpointId } });
    expect(stored).toBe(0);

    const updateRowsAfter = await updateAuditCount(secondEndpointId);
    const deleteRows = await prisma.auditEvent.count({
      where: {
        organizationId,
        action: 'webhook.endpoint.delete',
        resourceId: secondEndpointId,
      },
    });
    expect(deleteRows).toBe(1);
    expect(updateRowsAfter - updateRowsBefore).toBe(updateOutcome.status === 200 ? 1 : 0);

    const ghost = await patchEndpoint(
      hank.tokens.accessToken, organizationId, secondEndpointId, { active: false },
    );
    expect(ghost.status).toBe(404);
    expect((ghost.body as { message: string }).message).toBe('Webhook endpoint not found.');
  });

  it('lands a double-tapped update as two honest writes on one row', async () => {
    const before = await updateAuditCount(primaryEndpointId);
    const raced = await Promise.all([
      patchEndpoint(hank.tokens.accessToken, organizationId, primaryEndpointId, { url: receiverUrl + '/tapped' }),
      patchEndpoint(hank.tokens.accessToken, organizationId, primaryEndpointId, { url: receiverUrl + '/tapped' }),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(200);
    expect((raced[0].body as { url: string }).url).toBe(receiverUrl + '/tapped');
    expect((raced[1].body as { url: string }).url).toBe(receiverUrl + '/tapped');

    const stored = await prisma.webhookEndpoint.findUnique({
      where: { id: primaryEndpointId },
      select: { url: true },
    });
    expect(stored!.url).toBe(receiverUrl + '/tapped');

    const after = await updateAuditCount(primaryEndpointId);
    expect(after).toBe(before + 2);
  });

  it('merges two admins racing different fields into one honest row', async () => {
    const before = await updateAuditCount(primaryEndpointId);
    const raced = await Promise.all([
      patchEndpoint(hank.tokens.accessToken, organizationId, primaryEndpointId, { url: receiverUrl + '/raced' }),
      patchEndpoint(earl.tokens.accessToken, organizationId, primaryEndpointId, { active: false }),
    ]);
    expect(raced[0].status).toBe(200);
    expect(raced[1].status).toBe(200);

    const stored = await prisma.webhookEndpoint.findUnique({
      where: { id: primaryEndpointId },
      select: { url: true, active: true },
    });
    expect(stored!.url).toBe(receiverUrl + '/raced');
    expect(stored!.active).toBe(false);

    const after = await updateAuditCount(primaryEndpointId);
    expect(after).toBe(before + 2);
  });

  it('writes zero endpoint-update audit rows for reads and refusals overall', async () => {
    const before = await updateAuditCount(primaryEndpointId);

    const listed = await listEndpoints(hank.tokens.accessToken, organizationId);
    expect(listed.status).toBe(200);

    const foreignList = await listEndpoints(hank.tokens.accessToken, foreignOrganizationId);
    expect(foreignList.status).toBe(404);
    expect((foreignList.body as { message: string }).message).toBe('Organization not found.');

    const after = await updateAuditCount(primaryEndpointId);
    expect(after).toBe(before);
  });
});
