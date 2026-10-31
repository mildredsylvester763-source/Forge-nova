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
interface ApiResponse { status: number; body: Record<string, unknown>; }
interface ReceivedRequest { method: string; headers: Record<string, unknown>; body: string; }

/**
 * Webhook delivery races against the real app, the real CI Postgres, and
 * a real local node:http receiver. Grounded in the Stripe at-least-once
 * delivery model (each dispatch is an independent honest delivery) and
 * the GitHub and Stripe deletion law (deleting an endpoint immediately
 * stops its deliveries). A dispatch, retry, or system emission that
 * races an endpoint delete must end cleanly whichever way it lands -
 * never a 500, never a lost parent operation. No mocks.
 */
suite('GENESIS webhook delivery races (real app, real database, real receiver)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let dana: UserContext;
  let erin: UserContext;
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
    const email = 'genesis-whr-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'webhook-races-password-123',
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

  const eventHits = (eventName: string) =>
    received.filter((entry) => entry.body.indexOf('"event":"' + eventName + '"') !== -1).length;

  const createEndpoint = (token: string, url: string, eventSubscriptions: string[]) =>
    api(
      'POST',
      '/organizations/' + organizationId + '/webhooks/endpoints',
      { url, eventSubscriptions },
      token,
    );

  const removeEndpoint = (token: string, endpointId: string) =>
    api(
      'DELETE',
      '/organizations/' + organizationId + '/webhooks/endpoints/' + endpointId,
      undefined,
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
    if (createdUserIds.length > 0) {
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('prepares two members, a receiver, and a deployment endpoint', async () => {
    dana = await registerUser('dana');
    erin = await registerUser('erin');

    const organizations = await api('GET', '/organizations', undefined, dana.tokens.accessToken);
    expect(organizations.status).toBe(200);
    organizationId = (organizations.body as unknown as Array<{ id: string }>)[0].id;

    const addErin = await api(
      'POST',
      '/organizations/' + organizationId + '/members',
      { email: erin.email, role: 'ADMIN' },
      dana.tokens.accessToken,
    );
    expect(addErin.status).toBe(201);

    const created = await createEndpoint(dana.tokens.accessToken, receiverUrl, ['deployment.recorded']);
    expect(created.status).toBe(201);
    const body = created.body as { id: string; secret: string };
    expect(body.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
  });

  it('delivers two independent signed deliveries when two members press dispatch simultaneously', async () => {
    const hitsBefore = eventHits('deployment.recorded');
    const raced = await Promise.all([
      dispatch(dana.tokens.accessToken, 'deployment.recorded', { source: 'double-tap' }),
      dispatch(erin.tokens.accessToken, 'deployment.recorded', { source: 'double-tap' }),
    ]);
    expect(sortedStatuses(raced)).toEqual([201, 201]);
    const ids = new Set<string>();
    raced.forEach((response) => {
      const dispatchBody = response.body as {
        matchedEndpoints: number;
        deliveries: Array<{ deliveryId: string; status: string; lastStatusCode: number | null }>;
      };
      expect(dispatchBody.matchedEndpoints).toBe(1);
      expect(dispatchBody.deliveries.length).toBe(1);
      expect(dispatchBody.deliveries[0].status).toBe('DELIVERED');
      expect(dispatchBody.deliveries[0].lastStatusCode).toBe(200);
      ids.add(dispatchBody.deliveries[0].deliveryId);
    });
    expect(ids.size).toBe(2);
    expect(eventHits('deployment.recorded')).toBe(hitsBefore + 2);

    const audits = await prisma.auditEvent.count({
      where: { action: 'webhook.dispatch', resourceId: 'deployment.recorded', organizationId },
    });
    expect(audits).toBe(2);
  });

  it('skips an endpoint that dies mid-dispatch instead of surfacing a 500', async () => {
    const created = await createEndpoint(dana.tokens.accessToken, receiverUrl + '/b', ['checkpoint.created']);
    expect(created.status).toBe(201);
    const endpointId = (created.body as { id: string }).id;

    const hitsBefore = eventHits('checkpoint.created');
    const raced = await Promise.all([
      dispatch(dana.tokens.accessToken, 'checkpoint.created', { source: 'dispatch-vs-delete' }),
      removeEndpoint(erin.tokens.accessToken, endpointId),
    ]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(200);
    const dispatchBody = raced[0].body as {
      matchedEndpoints: number;
      deliveries: Array<{ status: string }>;
    };
    expect(dispatchBody.matchedEndpoints).toBeLessThanOrEqual(1);
    expect(dispatchBody.deliveries.length).toBeLessThanOrEqual(1);
    if (dispatchBody.deliveries.length === 1) {
      expect(dispatchBody.deliveries[0].status).toBe('DELIVERED');
    }
    expect(eventHits('checkpoint.created') - hitsBefore).toBeLessThanOrEqual(1);

    const leftover = await prisma.webhookDelivery.count({ where: { endpointId } });
    expect(leftover).toBe(0);

    const afterDelete = await dispatch(dana.tokens.accessToken, 'checkpoint.created', { source: 'post-delete' });
    expect(afterDelete.status).toBe(201);
    expect((afterDelete.body as { matchedEndpoints: number }).matchedEndpoints).toBe(0);
  });

  it('keeps a manual retry honest when the endpoint dies mid-retry', async () => {
    respondWithStatus = 500;
    const created = await createEndpoint(dana.tokens.accessToken, receiverUrl + '/c', ['reference.created']);
    expect(created.status).toBe(201);
    const endpointId = (created.body as { id: string }).id;

    const dispatched = await dispatch(dana.tokens.accessToken, 'reference.created', { source: 'retry-race' });
    expect(dispatched.status).toBe(201);
    const delivery = (dispatched.body as {
      deliveries: Array<{ deliveryId: string; status: string; attempts: number; lastError: string }>;
    }).deliveries[0];
    expect(delivery.status).toBe('PENDING');
    expect(delivery.attempts).toBe(1);
    expect(delivery.lastError).toContain('HTTP 500');
    respondWithStatus = 200;

    await backdateNextAttempt(delivery.deliveryId);
    const hitsBefore = eventHits('reference.created');
    const raced = await Promise.all([
      retryDelivery(dana.tokens.accessToken, delivery.deliveryId),
      removeEndpoint(erin.tokens.accessToken, endpointId),
    ]);
    expect([201, 404, 409]).toContain(raced[0].status);
    expect(raced[1].status).toBe(200);
    expect(eventHits('reference.created') - hitsBefore).toBeLessThanOrEqual(1);

    const leftover = await prisma.webhookDelivery.count({ where: { endpointId } });
    expect(leftover).toBe(0);

    const afterDelete = await retryDelivery(dana.tokens.accessToken, delivery.deliveryId);
    expect(afterDelete.status).toBe(404);
  });

  it('never fails the parent operation when an endpoint dies mid-emission', async () => {
    const created = await createEndpoint(dana.tokens.accessToken, receiverUrl + '/d', ['checkpoint.created']);
    expect(created.status).toBe(201);
    const endpointId = (created.body as { id: string }).id;

    const workspaces = await api('GET', '/workspaces', undefined, dana.tokens.accessToken);
    expect(workspaces.status).toBe(200);
    const workspaceId = (workspaces.body as unknown as Array<{ id: string }>)[0].id;
    const project = await api(
      'POST',
      '/workspaces/' + workspaceId + '/projects',
      { name: 'Webhook Race Project' },
      dana.tokens.accessToken,
    );
    expect(project.status).toBe(201);
    const projectId = (project.body as { id: string }).id;
    const application = await api(
      'POST',
      '/projects/' + projectId + '/applications',
      { name: 'Webhook Race App' },
      dana.tokens.accessToken,
    );
    expect(application.status).toBe(201);
    const applicationId = (application.body as { id: string }).id;

    const hitsBefore = eventHits('checkpoint.created');
    const raced = await Promise.all([
      api(
        'POST',
        '/applications/' + applicationId + '/checkpoints',
        { label: 'Emission race checkpoint.' },
        dana.tokens.accessToken,
      ),
      removeEndpoint(erin.tokens.accessToken, endpointId),
    ]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(200);
    expect(eventHits('checkpoint.created') - hitsBefore).toBeLessThanOrEqual(1);

    const leftover = await prisma.webhookDelivery.count({ where: { endpointId } });
    expect(leftover).toBe(0);

    const checkpoints = await api(
      'GET',
      '/applications/' + applicationId + '/checkpoints',
      undefined,
      dana.tokens.accessToken,
    );
    expect(checkpoints.status).toBe(200);
    expect((checkpoints.body as unknown as Array<{ id: string }>).length).toBe(1);
  });

  it('records honest failed deliveries when two members double-tap a dispatch at a dead receiver', async () => {
    respondWithStatus = 500;
    const raced = await Promise.all([
      dispatch(dana.tokens.accessToken, 'deployment.recorded', { attempt: 'dead-double' }),
      dispatch(erin.tokens.accessToken, 'deployment.recorded', { attempt: 'dead-double' }),
    ]);
    expect(sortedStatuses(raced)).toEqual([201, 201]);
    const ids = new Set<string>();
    raced.forEach((response) => {
      const dispatchBody = response.body as {
        deliveries: Array<{ deliveryId: string; status: string; attempts: number; lastError: string }>;
      };
      expect(dispatchBody.deliveries.length).toBe(1);
      expect(dispatchBody.deliveries[0].status).toBe('PENDING');
      expect(dispatchBody.deliveries[0].attempts).toBe(1);
      expect(dispatchBody.deliveries[0].lastError).toContain('HTTP 500');
      ids.add(dispatchBody.deliveries[0].deliveryId);
    });
    expect(ids.size).toBe(2);
    respondWithStatus = 200;

    const audits = await prisma.auditEvent.count({
      where: { action: 'webhook.dispatch', resourceId: 'deployment.recorded', organizationId },
    });
    expect(audits).toBe(4);
  });
});
