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
interface ReceivedRequest { method: string; url: string; headers: Record<string, unknown>; body: string; }
interface DeliveredEvent { event: string; payload: Record<string, unknown>; deliveryId: string; }

/**
 * Automatic lifecycle event emission against the real app, the real CI
 * Postgres, and a real local HTTP receiver. The design law under test is
 * the one the market leaders follow: Stripe fires an event for every
 * API-caused state change, and a webhook failure NEVER fails the parent
 * API call. GENESIS emits AFTER the parent operation commits, best-effort,
 * with a payload that honors its contract exactly, signed with the
 * endpoint secret - and stays completely silent for refused operations.
 */
suite('GENESIS automatic lifecycle events (real app, real database, real receiver)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let hans: UserContext;
  let ines: UserContext;
  let greta: UserContext;
  let ole: UserContext;
  let organizationId: string;
  let workspaceId: string;
  let projectId: string;
  let applicationId: string;
  let receiver: http.Server;
  let receiverUrl: string;
  let endpointSecret: string;
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
    const email = 'genesis-life-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'lifecycle-events-password-123',
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

  const createApplication = (token: string, name: string) =>
    api('POST', '/projects/' + projectId + '/applications', { name }, token);

  const createEndpoint = (token: string, url: string, eventSubscriptions: string[]) =>
    api('POST', '/organizations/' + organizationId + '/webhooks/endpoints', { url, eventSubscriptions }, token);

  const hitsAt = (path: string) =>
    received.filter((entry) => entry.method === 'POST' && entry.url === path);

  const lastHit = (path: string) => hitsAt(path)[hitsAt(path).length - 1];

  const parseHit = (entry: ReceivedRequest): DeliveredEvent =>
    JSON.parse(entry.body) as DeliveredEvent;

  const assertSignature = (entry: ReceivedRequest, secret: string) => {
    const signature = String(entry.headers[SIGNATURE_HEADER] ?? '');
    expect(signature).toMatch(/^t=[0-9]+,v1=[0-9a-f]{64}$/);
    const verification = verifySignature({
      secret,
      headerValue: signature,
      body: entry.body,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    expect(verification).toEqual({ valid: true });
    const tampered = verifySignature({
      secret,
      headerValue: signature,
      body: entry.body + ' ',
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    expect(tampered.valid).toBe(false);
  };

  const sortedKeys = (payload: Record<string, unknown>) =>
    Object.keys(payload).sort().join(',');

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
          url: req.url ?? '/',
          headers: req.headers as Record<string, unknown>,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.statusCode = 200;
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

  it('prepares members, a project, and an endpoint subscribed to everything', async () => {
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

    const workspaces = await api('GET', '/workspaces', undefined, hans.tokens.accessToken);
    expect(workspaces.status).toBe(200);
    workspaceId = (workspaces.body as unknown as Array<{ id: string }>)[0].id;

    const project = await api(
      'POST',
      '/workspaces/' + workspaceId + '/projects',
      { name: 'Lifecycle Project ' + runId },
      hans.tokens.accessToken,
    );
    expect(project.status).toBe(201);
    projectId = (project.body as { id: string }).id;

    const created = await createEndpoint(hans.tokens.accessToken, receiverUrl + '/main', ['all']);
    expect(created.status).toBe(201);
    const body = created.body as { id: string; secret: string; eventSubscriptions: string[] };
    expect(body.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(body.eventSubscriptions).toEqual(['all']);
    endpointSecret = body.secret;
  });

  it('emits application.created with a valid signature after the create commits', async () => {
    const created = await createApplication(hans.tokens.accessToken, 'Events App');
    expect(created.status).toBe(201);
    applicationId = (created.body as { id: string }).id;

    expect(hitsAt('/main').length).toBe(1);
    const hit = lastHit('/main');
    const parsed = parseHit(hit);
    expect(parsed.event).toBe('application.created');
    expect(parsed.payload.applicationId).toBe(applicationId);
    expect(parsed.payload.name).toBe('Events App');
    expect(sortedKeys(parsed.payload)).toBe('applicationId,name');
    assertSignature(hit, endpointSecret);
  });

  it('emits application.updated and application.archived across the lifecycle', async () => {
    const updated = await api(
      'PATCH',
      '/projects/' + projectId + '/applications/' + applicationId,
      { description: 'Now with lifecycle events.' },
      hans.tokens.accessToken,
    );
    expect(updated.status).toBe(200);
    const updatedHit = lastHit('/main');
    const updatedEvent = parseHit(updatedHit);
    expect(updatedEvent.event).toBe('application.updated');
    expect(updatedEvent.payload.applicationId).toBe(applicationId);
    expect(sortedKeys(updatedEvent.payload)).toBe('applicationId');

    const archived = await api(
      'POST',
      '/projects/' + projectId + '/applications/' + applicationId + '/archive',
      {},
      hans.tokens.accessToken,
    );
    expect(archived.status).toBe(201);
    const archivedHit = lastHit('/main');
    const archivedEvent = parseHit(archivedHit);
    expect(archivedEvent.event).toBe('application.archived');
    expect(archivedEvent.payload.applicationId).toBe(applicationId);
    assertSignature(archivedHit, endpointSecret);

    const restored = await api(
      'POST',
      '/projects/' + projectId + '/applications/' + applicationId + '/restore',
      {},
      hans.tokens.accessToken,
    );
    expect(restored.status).toBe(201);
    const restoredEvent = parseHit(lastHit('/main'));
    expect(restoredEvent.event).toBe('application.updated');
    expect(restoredEvent.payload.applicationId).toBe(applicationId);
  });

  it('emits checkpoint.created and checkpoint.restored with honest change counts', async () => {
    const checkpoint = await api(
      'POST',
      '/applications/' + applicationId + '/checkpoints',
      { label: 'events-checkpoint' },
      hans.tokens.accessToken,
    );
    expect(checkpoint.status).toBe(201);
    const checkpointId = (checkpoint.body as { id: string }).id;

    const createdHit = lastHit('/main');
    const createdEvent = parseHit(createdHit);
    expect(createdEvent.event).toBe('checkpoint.created');
    expect(createdEvent.payload.applicationId).toBe(applicationId);
    expect(createdEvent.payload.checkpointId).toBe(checkpointId);
    expect(createdEvent.payload.label).toBe('events-checkpoint');
    expect(sortedKeys(createdEvent.payload)).toBe('applicationId,checkpointId,label');
    assertSignature(createdHit, endpointSecret);

    const restore = await api(
      'POST',
      '/applications/' + applicationId + '/checkpoints/' + checkpointId + '/restore',
      {},
      hans.tokens.accessToken,
    );
    expect(restore.status).toBe(201);
    expect((restore.body as { changedFiles: number }).changedFiles).toBe(0);

    const restoredEvent = parseHit(lastHit('/main'));
    expect(restoredEvent.event).toBe('checkpoint.restored');
    expect(restoredEvent.payload.applicationId).toBe(applicationId);
    expect(restoredEvent.payload.checkpointId).toBe(checkpointId);
    expect(restoredEvent.payload.changedFiles).toBe(0);
    expect(sortedKeys(restoredEvent.payload)).toBe('applicationId,changedFiles,checkpointId');
  });

  it('emits reference.created after the reference commits', async () => {
    const reference = await api(
      'POST',
      '/applications/' + applicationId + '/references',
      { title: 'Events spec', kind: 'SPEC', content: 'The platform must emit lifecycle events.' },
      hans.tokens.accessToken,
    );
    expect(reference.status).toBe(201);
    const referenceId = (reference.body as { id: string }).id;

    const hit = lastHit('/main');
    const parsed = parseHit(hit);
    expect(parsed.event).toBe('reference.created');
    expect(parsed.payload.applicationId).toBe(applicationId);
    expect(parsed.payload.referenceId).toBe(referenceId);
    expect(parsed.payload.kind).toBe('SPEC');
    expect(parsed.payload.title).toBe('Events spec');
    expect(sortedKeys(parsed.payload)).toBe('applicationId,kind,referenceId,title');
    assertSignature(hit, endpointSecret);
  });

  it('emits verification.completed with the exact run identities', async () => {
    const response = await api(
      'POST',
      '/applications/' + applicationId + '/verifications',
      {},
      hans.tokens.accessToken,
    );
    expect(response.status).toBe(201);
    const runs = response.body as unknown as Array<{ id: string; kind: string; status: string }>;
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBe(3);
    for (const run of runs) {
      expect(['PASSED', 'SKIPPED']).toContain(run.status);
    }

    const hit = lastHit('/main');
    const parsed = parseHit(hit);
    expect(parsed.event).toBe('verification.completed');
    expect(parsed.payload.applicationId).toBe(applicationId);
    const emittedRuns = parsed.payload.runs as unknown as Array<{ id: string; kind: string; status: string }>;
    expect(emittedRuns.length).toBe(3);
    expect(new Set(emittedRuns.map((entry) => entry.id))).toEqual(new Set(runs.map((entry) => entry.id)));
    for (const emitted of emittedRuns) {
      const source = runs.find((entry) => entry.id === emitted.id);
      expect(source).toBeDefined();
      expect(emitted.kind).toBe(source!.kind);
      expect(emitted.status).toBe(source!.status);
    }
    expect(sortedKeys(parsed.payload)).toBe('applicationId,runs');
    assertSignature(hit, endpointSecret);
  });

  it('stays silent when the readiness engine refuses a deployment', async () => {
    const before = hitsAt('/main').length;
    const refused = await api(
      'POST',
      '/applications/' + applicationId + '/deployments',
      { environment: 'production' },
      hans.tokens.accessToken,
    );
    expect(refused.status).toBe(400);
    expect(hitsAt('/main').length).toBe(before);
  });

  it('emits deployment.recorded once a real deployment commits', async () => {
    const file = await api(
      'POST',
      '/applications/' + applicationId + '/files',
      { path: 'index.html', content: '<html><body>lifecycle</body></html>', language: 'html' },
      hans.tokens.accessToken,
    );
    expect(file.status).toBe(201);

    const verification = await api(
      'POST',
      '/applications/' + applicationId + '/verifications',
      {},
      hans.tokens.accessToken,
    );
    expect(verification.status).toBe(201);

    const deployment = await api(
      'POST',
      '/applications/' + applicationId + '/deployments',
      { environment: 'staging' },
      hans.tokens.accessToken,
    );
    expect(deployment.status).toBe(201);
    const deploymentId = (deployment.body as { id: string }).id;

    const hit = lastHit('/main');
    const parsed = parseHit(hit);
    expect(parsed.event).toBe('deployment.recorded');
    expect(parsed.payload.applicationId).toBe(applicationId);
    expect(parsed.payload.deploymentId).toBe(deploymentId);
    expect(parsed.payload.environment).toBe('staging');
    expect(typeof parsed.payload.verdict).toBe('string');
    expect((parsed.payload.verdict as string).length).toBeGreaterThan(0);
    expect(sortedKeys(parsed.payload)).toBe('applicationId,deploymentId,environment,verdict');
    assertSignature(hit, endpointSecret);
  });

  it('never lets a dead endpoint fail the parent API call', async () => {
    const dead = await createEndpoint(hans.tokens.accessToken, 'http://127.0.0.1:1/', ['application.*']);
    expect(dead.status).toBe(201);
    const deadId = (dead.body as { id: string }).id;

    const before = hitsAt('/main').length;
    const created = await createApplication(hans.tokens.accessToken, 'Resilient App');
    expect(created.status).toBe(201);
    expect(hitsAt('/main').length).toBe(before + 1);

    const row = await prisma.webhookDelivery.findFirst({ where: { endpointId: deadId } });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('PENDING');
    expect(row!.eventName).toBe('application.created');
    expect(row!.attempts).toBe(1);
    expect(typeof row!.lastError).toBe('string');
    expect((row!.lastError as string).length).toBeGreaterThan(0);
  });

  it('emits exactly one event per application when two writers race', async () => {
    const before = hitsAt('/main').length;
    const [alpha, beta] = await Promise.all([
      createApplication(hans.tokens.accessToken, 'Race App Alpha'),
      createApplication(ines.tokens.accessToken, 'Race App Beta'),
    ]);
    expect(alpha.status).toBe(201);
    expect(beta.status).toBe(201);
    const alphaId = (alpha.body as { id: string }).id;
    const betaId = (beta.body as { id: string }).id;
    expect(alphaId).not.toBe(betaId);

    expect(hitsAt('/main').length).toBe(before + 2);
    const newHits = hitsAt('/main').slice(before);
    const ids = newHits.map((entry) => (parseHit(entry).payload.applicationId as string));
    expect(new Set(ids)).toEqual(new Set([alphaId, betaId]));
    for (const entry of newHits) {
      const parsed = parseHit(entry);
      expect(parsed.event).toBe('application.created');
      assertSignature(entry, endpointSecret);
    }
  });

  it('emits nothing for refused operations', async () => {
    const before = hitsAt('/main').length;
    const viewerCreate = await createApplication(greta.tokens.accessToken, 'Denied App');
    expect([403, 404]).toContain(viewerCreate.status);

    const unknownId = 'no-such-application-' + runId;
    const unknownUpdate = await api(
      'PATCH',
      '/projects/' + projectId + '/applications/' + unknownId,
      { description: 'Should not exist.' },
      hans.tokens.accessToken,
    );
    expect(unknownUpdate.status).toBe(404);

    const unknownCheckpoint = await api(
      'POST',
      '/applications/' + unknownId + '/checkpoints',
      { label: 'should-not-exist' },
      hans.tokens.accessToken,
    );
    expect(unknownCheckpoint.status).toBe(404);

    expect(hitsAt('/main').length).toBe(before);
  });

  it('respects per-endpoint subscriptions', async () => {
    const ck = await createEndpoint(ines.tokens.accessToken, receiverUrl + '/ck', ['checkpoint.*']);
    expect(ck.status).toBe(201);
    const ckBody = ck.body as { id: string; secret: string };
    expect(hitsAt('/ck').length).toBe(0);

    const created = await createApplication(hans.tokens.accessToken, 'Checkpoint Only App');
    expect(created.status).toBe(201);
    const ckAppId = (created.body as { id: string }).id;
    expect(hitsAt('/ck').length).toBe(0);

    const checkpoint = await api(
      'POST',
      '/applications/' + ckAppId + '/checkpoints',
      { label: 'ck-checkpoint' },
      hans.tokens.accessToken,
    );
    expect(checkpoint.status).toBe(201);

    expect(hitsAt('/ck').length).toBe(1);
    const hit = lastHit('/ck');
    const parsed = parseHit(hit);
    expect(parsed.event).toBe('checkpoint.created');
    expect(parsed.payload.applicationId).toBe(ckAppId);
    assertSignature(hit, ckBody.secret);
  });

  it('keeps the audit trail honest while system emission stays out of it', async () => {
    const trail = await api(
      'GET',
      '/organizations/' + organizationId + '/audit-events',
      undefined,
      hans.tokens.accessToken,
    );
    expect(trail.status).toBe(200);
    const actions = (trail.body as unknown as Array<{ action: string }>).map((event) => event.action);
    expect(actions).toContain('application.create');
    expect(actions).toContain('application.update');
    expect(actions).toContain('application.archive');
    expect(actions).toContain('application.restore');
    expect(actions).toContain('application.checkpoint.create');
    expect(actions).toContain('application.checkpoint.restore');
    expect(actions).toContain('application.reference.create');
    expect(actions).toContain('application.verification.run');
    expect(actions).toContain('application.deployment.record');
    expect(actions).toContain('webhook.endpoint.create');
    expect(actions.filter((action) => action.startsWith('system.')).length).toBe(0);
  });
});
