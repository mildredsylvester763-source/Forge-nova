import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

const hasDatabase = typeof process.env.DATABASE_URL === 'string'
  && process.env.DATABASE_URL.startsWith('postgres');
const hasJwtSecret = typeof process.env.JWT_ACCESS_SECRET === 'string'
  && process.env.JWT_ACCESS_SECRET.length >= 32;
const suite = hasDatabase && hasJwtSecret ? describe : describe.skip;

interface TokenPair { accessToken: string; refreshToken: string; }
interface UserContext { email: string; tokens: TokenPair; userId: string; }
interface KeyContext { id: string; key: string; }
interface ApiResponse { status: number; body: Record<string, unknown>; }

/**
 * Keyed AI source generation trigger over the real app and the real CI
 * PostgreSQL. Grounded in the market leaders: OpenAI create-a-model-
 * response and Anthropic create-a-message both run generation straight
 * from an API key, and OpenAI binds every key to one organization so a
 * revocation lands within seconds. The keyed trigger mirrors the JWT
 * trigger through one shared idempotent enqueue core so the two
 * surfaces can never drift: Stripe-style idempotency makes a
 * double-tap converge on the same queued job, a reused key with a
 * different payload answers one honest 409, the writable tenant bound
 * keeps foreign and archived applications behind a uniform 404, a key
 * whose creator is gone answers a named 409 instead of inventing an
 * actor, and every refusal leaves no job row behind.
 */
suite('genapi key-authenticated AI generation flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId = '';
  let foreignOrganizationId = '';
  let projectIdA = '';
  let foreignProjectId = '';
  let applicationIdA = '';
  let foreignApplicationId = '';
  let archivedApplicationId = '';
  let writerKey: KeyContext;
  let readerKey: KeyContext;
  let orgWriterKey: KeyContext;
  let shortLivedKey: KeyContext;
  let revokedKey: KeyContext;
  let irisWriterKey: KeyContext;
  let samOrgId = '';
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);
  const password = 'genapi-generation-password-123';

  const api = async (
    method: string,
    path: string,
    body: unknown = undefined,
    accessToken?: string,
  ): Promise<ApiResponse> => {
    const response = await fetch(baseUrl + path, {
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
    const email = 'genesis-gen-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password,
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
    accessToken: string,
    orgId: string,
    name: string,
    scopes: string[],
    expiresAt?: string,
  ): Promise<KeyContext> => {
    const body = expiresAt === undefined
      ? { name, scopes }
      : { name, scopes, expiresAt };
    const response = await api(
      'POST',
      '/organizations/' + orgId + '/api-keys',
      body,
      accessToken,
    );
    expect(response.status).toBe(201);
    const created = response.body as { id: string; key: string };
    expect(created.key).toMatch(/^gn_live_[A-Za-z0-9_-]{43}$/);
    return { id: created.id, key: created.key };
  };

  const jobsInApplication = (applicationId: string) =>
    prisma.workJob.count({ where: { applicationId } });

  const generate = (applicationId: string, prompt: string, idempotencyKey: string, key: string | undefined) =>
    api('POST', '/genapi/applications/' + applicationId + '/generate', { prompt, idempotencyKey }, key);

  const seedTenant = async (owner: UserContext, projectName: string, appName: string) => {
    const orgs = await api('GET', '/organizations', undefined, owner.tokens.accessToken);
    expect(orgs.status).toBe(200);
    const orgId = (orgs.body as unknown as Array<{ id: string }>)[0].id;
    const workspaces = await api('GET', '/workspaces', undefined, owner.tokens.accessToken);
    expect(workspaces.status).toBe(200);
    const workspaceId = (workspaces.body as unknown as Array<{ id: string }>)[0].id;
    const project = await api(
      'POST',
      '/workspaces/' + workspaceId + '/projects',
      { name: projectName },
      owner.tokens.accessToken,
    );
    expect(project.status).toBe(201);
    const projectId = (project.body as { id: string }).id;
    const application = await api(
      'POST',
      '/projects/' + projectId + '/applications',
      { name: appName },
      owner.tokens.accessToken,
    );
    expect(application.status).toBe(201);
    return {
      organizationId: orgId,
      projectId,
      applicationId: (application.body as { id: string }).id,
    };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({}).compile();
    await moduleRef.close();

    const { AppModule } = await import('../app.module');
    const testing = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = testing.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }));
    await app.init();
    await app.listen(0, '127.0.0.1');

    const server = app.getHttpServer() as import('node:http').Server;
    const address = server.address() as { port: number };
    baseUrl = 'http://127.0.0.1:' + address.port + '/api/v1';
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const orgIds = [organizationId, foreignOrganizationId, samOrgId].filter((id) => id !== '');
    if (orgIds.length > 0) {
      await prisma.auditEvent.deleteMany({ where: { organizationId: { in: orgIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
    }
    if (samOrgId !== '') {
      await prisma.organization.deleteMany({ where: { id: samOrgId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it('seeds two tenants, an application, and keys with distinct scopes', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const tenantA = await seedTenant(hank, 'Genapi Generation Project', 'Genapi Generation App');
    organizationId = tenantA.organizationId;
    projectIdA = tenantA.projectId;
    applicationIdA = tenantA.applicationId;
    const tenantB = await seedTenant(iris, 'Iris Generation Project', 'Iris Generation App');
    foreignOrganizationId = tenantB.organizationId;
    foreignProjectId = tenantB.projectId;
    foreignApplicationId = tenantB.applicationId;

    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'Gen Writer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    readerKey = await createKey(hank.tokens.accessToken, organizationId, 'Gen Reader', ['READ_APPLICATIONS']);
    orgWriterKey = await createKey(hank.tokens.accessToken, organizationId, 'Org Writer', ['READ_ORGANIZATION', 'WRITE_ORGANIZATION']);
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Short Lived',
      ['READ_APPLICATIONS', 'WRITE_APPLICATIONS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(hank.tokens.accessToken, organizationId, 'Revoked', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    irisWriterKey = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Iris Gen Writer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
  });

  it('mirrors the JWT trigger with key-creator attribution', async () => {
    const keyed = await generate(applicationIdA, '  Ship the landing page.  ', 'gen-' + runId + '-parity-keyed', writerKey.key);
    expect(keyed.status).toBe(201);
    const jwt = await api(
      'POST',
      '/applications/' + applicationIdA + '/generate',
      { prompt: 'Ship the dashboard.', idempotencyKey: 'gen-' + runId + '-parity-jwt' },
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(201);
    expect(Object.keys(keyed.body).sort()).toEqual(Object.keys(jwt.body).sort());

    const keyedBody = keyed.body as { jobId: string; applicationId: string; status: string; createdAt: string };
    expect(keyedBody.applicationId).toBe(applicationIdA);
    expect(keyedBody.status).toBe('QUEUED');
    expect(typeof keyedBody.jobId).toBe('string');
    expect(typeof keyedBody.createdAt).toBe('string');

    const keyedJob = await prisma.workJob.findUnique({
      where: { id: keyedBody.jobId },
      select: { type: true, status: true, idempotencyKey: true, input: true, applicationId: true },
    });
    expect(keyedJob).not.toBeNull();
    expect(keyedJob?.type).toBe('CODE_GENERATION');
    expect(keyedJob?.status).toBe('QUEUED');
    expect(keyedJob?.applicationId).toBe(applicationIdA);
    expect(keyedJob?.idempotencyKey).toBe('gen-' + runId + '-parity-keyed');
    const keyedInput = (keyedJob?.input ?? {}) as Record<string, unknown>;
    expect(Object.keys(keyedInput).sort()).toEqual(['apiKeyId', 'apiKeyName', 'prompt', 'requestedBy', 'task', 'via']);
    expect(keyedInput.task).toBe('GENERATE_SOURCE_FILES');
    expect(keyedInput.prompt).toBe('Ship the landing page.');
    expect(keyedInput.requestedBy).toBe(hank.userId);
    expect(keyedInput.via).toBe('genapi');
    expect(keyedInput.apiKeyId).toBe(writerKey.id);
    expect(keyedInput.apiKeyName).toBe('Gen Writer');

    const jwtBody = jwt.body as { jobId: string };
    const jwtJob = await prisma.workJob.findUnique({
      where: { id: jwtBody.jobId },
      select: { input: true },
    });
    const jwtInput = (jwtJob?.input ?? {}) as Record<string, unknown>;
    expect(Object.keys(jwtInput).sort()).toEqual(['prompt', 'requestedBy', 'task']);
    expect(jwtInput.task).toBe('GENERATE_SOURCE_FILES');
    expect(jwtInput.requestedBy).toBe(hank.userId);

    const keyedList = await api('GET', '/genapi/applications/' + applicationIdA + '/jobs', undefined, readerKey.key);
    expect(keyedList.status).toBe(200);
    const keyedIds = (keyedList.body as unknown as Array<{ id: string }>).map((item) => item.id);
    expect(keyedIds).toContain(keyedBody.jobId);
    const jwtList = await api('GET', '/applications/' + applicationIdA + '/jobs', undefined, hank.tokens.accessToken);
    expect(jwtList.status).toBe(200);
    expect(keyedList.body).toEqual(jwtList.body);
  });

  it('replays an idempotent trigger into the same queued job', async () => {
    const idempotencyKey = 'gen-' + runId + '-replay';
    const first = await generate(applicationIdA, 'Replay the same prompt.', idempotencyKey, writerKey.key);
    expect(first.status).toBe(201);
    const second = await generate(applicationIdA, 'Replay the same prompt.', idempotencyKey, writerKey.key);
    expect(second.status).toBe(201);
    expect((second.body as { jobId: string }).jobId).toBe((first.body as { jobId: string }).jobId);

    const rows = await prisma.workJob.count({
      where: { applicationId: applicationIdA, idempotencyKey },
    });
    expect(rows).toBe(1);
  });

  it('refuses a reused idempotency key with a different payload honestly', async () => {
    const idempotencyKey = 'gen-' + runId + '-conflict';
    const first = await generate(applicationIdA, 'First payload prompt.', idempotencyKey, writerKey.key);
    expect(first.status).toBe(201);
    const rowsBefore = await jobsInApplication(applicationIdA);

    const second = await generate(applicationIdA, 'A different prompt entirely.', idempotencyKey, writerKey.key);
    expect(second.status).toBe(409);
    expect((second.body as { message: string }).message).toBe('This idempotency key was already used for a different job payload.');
    expect(await jobsInApplication(applicationIdA)).toBe(rowsBefore);
  });

  it('refuses triggers without side effects', async () => {
    const rowsBefore = await jobsInApplication(applicationIdA);

    const scopeMessages = new Set<string>();
    for (const wrongKey of [readerKey, orgWriterKey]) {
      const refused = await generate(applicationIdA, 'Scope refusal prompt.', 'gen-' + runId + '-scope', wrongKey.key);
      expect(refused.status).toBe(403);
      scopeMessages.add((refused.body as { message: string }).message);
    }
    expect(scopeMessages.size).toBe(1);
    expect(Array.from(scopeMessages)[0]).toBe('The API key does not grant the required scope.');

    const blank = await generate(applicationIdA, '   ', 'gen-' + runId + '-blank', writerKey.key);
    expect(blank.status).toBe(400);
    const tooLong = await generate(applicationIdA, 'x'.repeat(20001), 'gen-' + runId + '-long', writerKey.key);
    expect(tooLong.status).toBe(400);
    const badKey = await generate(applicationIdA, 'Bad key prompt.', 'short', writerKey.key);
    expect(badKey.status).toBe(400);
    const missingKey = await api(
      'POST',
      '/genapi/applications/' + applicationIdA + '/generate',
      { prompt: 'Missing key prompt.' },
      writerKey.key,
    );
    expect(missingKey.status).toBe(400);
    const extraField = await api(
      'POST',
      '/genapi/applications/' + applicationIdA + '/generate',
      { prompt: 'Extra field prompt.', idempotencyKey: 'gen-' + runId + '-extra', surprise: true },
      writerKey.key,
    );
    expect(extraField.status).toBe(400);

    expect(await jobsInApplication(applicationIdA)).toBe(rowsBefore);
  });

  it('tenant-bounds the trigger behind a uniform 404', async () => {
    const rowsBefore = await jobsInApplication(applicationIdA);

    const messages = new Set<string>();
    const probes: Array<[string, string, KeyContext]> = [
      [applicationIdA, 'gen-' + runId + 'bound-a', irisWriterKey],
      [foreignApplicationId, 'gen-' + runId + 'bound-b', writerKey],
      ['unknown-application-id', 'gen-' + runId + 'bound-c', writerKey],
    ];
    for (const [applicationId, idempotencyKey, keyContext] of probes) {
      const refused = await generate(applicationId, 'Tenant bound prompt.', idempotencyKey, keyContext.key);
      expect(refused.status).toBe(404);
      messages.add((refused.body as { message: string }).message);
    }
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Application not found.');
    expect(await jobsInApplication(applicationIdA)).toBe(rowsBefore);
    expect(await jobsInApplication(foreignApplicationId)).toBe(0);
  });

  it('answers honestly when the key creator no longer exists', async () => {
    const sam = await registerUser('sam');
    const samOrgs = await api('GET', '/organizations', undefined, sam.tokens.accessToken);
    expect(samOrgs.status).toBe(200);
    samOrgId = (samOrgs.body as unknown as Array<{ id: string }>)[0].id;
    await prisma.membership.create({
      data: { userId: sam.userId, organizationId, role: 'ADMIN' },
    });
    const samKey = await createKey(sam.tokens.accessToken, organizationId, 'Orphan Gen Writer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);

    await prisma.user.delete({ where: { id: sam.userId } });

    const rowsBefore = await jobsInApplication(applicationIdA);
    const refused = await generate(applicationIdA, 'Orphan trigger prompt.', 'gen-' + runId + '-orphan', samKey.key);
    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toBe('The key creator no longer exists.');
    expect(await jobsInApplication(applicationIdA)).toBe(rowsBefore);
  });

  it('race: a keyed double-tap converges on one queued job', async () => {
    const idempotencyKey = 'gen-' + runId + '-race-tap';
    const raced = await Promise.all([
      generate(applicationIdA, 'Race tap prompt.', idempotencyKey, writerKey.key),
      generate(applicationIdA, 'Race tap prompt.', idempotencyKey, writerKey.key),
    ]);
    for (const response of raced) {
      expect(response.status).toBe(201);
      expect((response.body as { status: string }).status).toBe('QUEUED');
    }
    const jobIds = new Set(raced.map((response) => (response.body as { jobId: string }).jobId));
    expect(jobIds.size).toBe(1);

    const rows = await prisma.workJob.count({
      where: { applicationId: applicationIdA, idempotencyKey },
    });
    expect(rows).toBe(1);
  });

  it('race: keyed against JWT on one idempotency key ends exactly one way', async () => {
    const idempotencyKey = 'gen-' + runId + '-race-cross';
    const rowsBefore = await jobsInApplication(applicationIdA);

    const raced = await Promise.all([
      generate(applicationIdA, 'Cross race keyed prompt.', idempotencyKey, writerKey.key),
      api(
        'POST',
        '/applications/' + applicationIdA + '/generate',
        { prompt: 'Cross race jwt prompt.', idempotencyKey },
        hank.tokens.accessToken,
      ),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 409]);
    // Two honest refusals exist: the loser may read the committed winner
    // through the pre-check and answer the different-payload 409, or it
    // may lose the insert race and answer the already-exists 409. Both
    // end the race exactly one way, so the SET of clean outcomes is the
    // honest assertion, never one specific message.
    const refused = raced.find((response) => response.status === 409) as ApiResponse;
    expect([
      'This idempotency key was already used for a different job payload.',
      'A job with this idempotency key already exists.',
    ]).toContain((refused.body as { message: string }).message);

    expect(await jobsInApplication(applicationIdA)).toBe(rowsBefore + 1);
    const row = await prisma.workJob.findFirst({
      where: { applicationId: applicationIdA, idempotencyKey },
      select: { type: true, status: true, input: true },
    });
    expect(row?.type).toBe('CODE_GENERATION');
    expect(row?.status).toBe('QUEUED');
    const input = (row?.input ?? {}) as Record<string, unknown>;
    if (input.via === 'genapi') {
      expect(input.apiKeyId).toBe(writerKey.id);
      expect(input.prompt).toBe('Cross race keyed prompt.');
    } else {
      expect(input.prompt).toBe('Cross race jwt prompt.');
      expect(input.requestedBy).toBe(hank.userId);
    }
  });

  it('keeps an archived application behind the writable 404', async () => {
    const created = await api(
      'POST',
      '/projects/' + projectIdA + '/applications',
      { name: 'Genapi Archived App' },
      hank.tokens.accessToken,
    );
    expect(created.status).toBe(201);
    archivedApplicationId = (created.body as { id: string }).id;
    const archived = await api(
      'POST',
      '/projects/' + projectIdA + '/applications/' + archivedApplicationId + '/archive',
      {},
      hank.tokens.accessToken,
    );
    expect(archived.status).toBe(201);

    const refused = await generate(archivedApplicationId, 'Archived app prompt.', 'gen-' + runId + '-archived', writerKey.key);
    expect(refused.status).toBe(404);
    expect((refused.body as { message: string }).message).toBe('Application not found.');
    expect(await jobsInApplication(archivedApplicationId)).toBe(0);
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect([200, 201]).toContain(revoke.status);

    const revokedTry = await generate(applicationIdA, 'Revoked prompt.', 'gen-' + runId + '-revoked', revokedKey.key);
    expect(revokedTry.status).toBe(401);
    expect((revokedTry.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredTry = await generate(applicationIdA, 'Expired prompt.', 'gen-' + runId + '-expired', shortLivedKey.key);
    expect(expiredTry.status).toBe(401);
    expect((expiredTry.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const anonymous = await generate(applicationIdA, 'Anonymous prompt.', 'gen-' + runId + '-anonymous', undefined);
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { message: string }).message).toBe('A valid GENESIS API key is required.');
  });
});
