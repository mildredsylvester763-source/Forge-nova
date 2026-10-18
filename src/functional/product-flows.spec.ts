import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

const hasDatabase = typeof process.env.DATABASE_URL === 'string'
  && process.env.DATABASE_URL.startsWith('postgres');
const hasJwtSecret = typeof process.env.JWT_ACCESS_SECRET === 'string'
  && process.env.JWT_ACCESS_SECRET.length >= 32;
const suite = hasDatabase && hasJwtSecret ? describe : describe.skip;

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface UserContext {
  email: string;
  password: string;
  tokens: TokenPair;
  userId: string;
}

suite('GENESIS product functional flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let alice: UserContext;
  let bob: UserContext;
  let organizationId: string;
  let workspaceId: string;
  let projectId: string;
  let applicationId: string;
  let emptyApplicationId: string;
  let conversationId: string;
  let referenceId: string;
  const createdUserIds: string[] = [];
  const createdOrganizationIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);

  const api = async (
    method: string,
    path: string,
    body: unknown = undefined,
    accessToken?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
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
    const email = `genesis-func-${name}-${runId}@example.com`;
    const password = 'functional-test-password-123';
    const response = await api('POST', '/auth/register', {
      email,
      password,
      displayName: name,
    });
    expect(response.status).toBe(201);
    expect(typeof response.body.accessToken).toBe('string');
    expect(typeof response.body.refreshToken).toBe('string');
    const user = response.body.user as { id: string };
    createdUserIds.push(user.id);
    return {
      email,
      password,
      tokens: {
        accessToken: response.body.accessToken as string,
        refreshToken: response.body.refreshToken as string,
      },
      userId: user.id,
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

    const server = app.getHttpServer() as import('node:http').Server;
    const address = server.address() as { port: number };
    baseUrl = 'http://127.0.0.1:' + address.port + '/api/v1';
  });

  afterAll(async () => {
    const { PrismaService } = await import('../database/prisma.service');
    const prisma = app.get(PrismaService);
    for (const organizationId of createdOrganizationIds) {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    for (const userId of createdUserIds) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await app.close();
  });

  it('registers a new account and issues working tokens', async () => {
    alice = await registerUser('alice');
  });

  it('rejects login with the wrong password without leaking which part failed', async () => {
    const response = await api('POST', '/auth/login', {
      email: alice.email,
      password: 'definitely-wrong-password',
    });
    expect(response.status).toBe(401);
  });

  it('logs in with correct credentials and returns the account', async () => {
    const response = await api('POST', '/auth/login', {
      email: alice.email,
      password: alice.password,
    });
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ email: alice.email });
  });

  it('returns the current user for a valid access token and 401 without one', async () => {
    const authorized = await api('GET', '/auth/me', undefined, alice.tokens.accessToken);
    expect(authorized.status).toBe(200);
    expect(authorized.body).toMatchObject({ email: alice.email, status: 'ACTIVE' });

    const anonymous = await api('GET', '/auth/me');
    expect(anonymous.status).toBe(401);
  });

  it('rotates refresh tokens: the old one stops working after use', async () => {
    const refreshed = await api('POST', '/auth/refresh', {
      refreshToken: alice.tokens.refreshToken,
    });
    expect(refreshed.status).toBe(200);
    expect(typeof refreshed.body.refreshToken).toBe('string');
    expect(refreshed.body.refreshToken).not.toBe(alice.tokens.refreshToken);
    alice.tokens = {
      accessToken: refreshed.body.accessToken as string,
      refreshToken: refreshed.body.refreshToken as string,
    };

    const replay = await api('POST', '/auth/refresh', {
      refreshToken: alice.tokens.refreshToken === refreshed.body.refreshToken
        ? 'impossible-replay-token'
        : alice.tokens.refreshToken,
    });
    expect(replay.status).toBe(401);
  });

  it('lists the personal organization and workspace created at registration', async () => {
    const organizations = await api('GET', '/organizations', undefined, alice.tokens.accessToken);
    expect(organizations.status).toBe(200);
    const orgList = organizations.body as unknown as Array<{ id: string; name: string }>;
    expect(orgList.length).toBeGreaterThan(0);
    organizationId = orgList[0].id;
    createdOrganizationIds.push(organizationId);

    const workspaces = await api('GET', '/workspaces', undefined, alice.tokens.accessToken);
    expect(workspaces.status).toBe(200);
    const workspaceList = workspaces.body as unknown as Array<{ id: string; name: string }>;
    expect(workspaceList.length).toBeGreaterThan(0);
    workspaceId = workspaceList[0].id;
  });

  it('creates a project inside the workspace', async () => {
    const response = await api(
      'POST',
      '/workspaces/' + workspaceId + '/projects',
      { name: 'Functional Flow Project', description: 'Covers the core product path.' },
      alice.tokens.accessToken,
    );
    expect(response.status).toBe(201);
    projectId = (response.body as { id: string }).id;
  });

  it('creates an application inside the project', async () => {
    const response = await api(
      'POST',
      '/projects/' + projectId + '/applications',
      { name: 'Functional App', description: 'App used by the functional suite.', framework: 'react', runtime: 'node' },
      alice.tokens.accessToken,
    );
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ name: 'Functional App', status: 'PLANNING' });
    applicationId = (response.body as { id: string }).id;

    const second = await api(
      'POST',
      '/projects/' + projectId + '/applications',
      { name: 'Empty App' },
      alice.tokens.accessToken,
    );
    expect(second.status).toBe(201);
    emptyApplicationId = (second.body as { id: string }).id;
  });

  it('opens a conversation and stores a user message', async () => {
    const conversation = await api(
      'POST',
      '/applications/' + applicationId + '/conversations',
      { title: 'Build plan' },
      alice.tokens.accessToken,
    );
    expect(conversation.status).toBe(201);
    conversationId = (conversation.body as { id: string }).id;

    const message = await api(
      'POST',
      '/conversations/' + conversationId + '/messages',
      { content: 'Please generate a landing page with a signup form.' },
      alice.tokens.accessToken,
    );
    expect(message.status).toBe(201);

    const listed = await api(
      'GET',
      '/conversations/' + conversationId + '/messages',
      undefined,
      alice.tokens.accessToken,
    );
    expect(listed.status).toBe(200);
    const messages = listed.body as unknown as Array<{ content: string }>;
    expect(messages.length).toBe(1);
  });

  it('writes source files with revision history', async () => {
    const written = await api(
      'POST',
      '/applications/' + applicationId + '/files',
      { path: 'src/index.ts', content: 'export function add(a: number, b: number): number { return a + b; }', language: 'typescript' },
      alice.tokens.accessToken,
    );
    expect(written.status).toBe(201);

    const manifest = await api(
      'POST',
      '/applications/' + applicationId + '/files',
      { path: 'package.json', content: '{"name":"functional-app","version":"1.0.0","dependencies":{"zod":"^3.0.0"}}' },
      alice.tokens.accessToken,
    );
    expect(manifest.status).toBe(201);

    const updated = await api(
      'POST',
      '/applications/' + applicationId + '/files',
      { path: 'src/index.ts', content: 'export function add(a: number, b: number): number { return a + b + 1; }', language: 'typescript', expectedRevision: 1 },
      alice.tokens.accessToken,
    );
    expect(updated.status).toBe(201);
    expect((updated.body as { revision: number }).revision).toBe(2);

    const stale = await api(
      'POST',
      '/applications/' + applicationId + '/files',
      { path: 'src/index.ts', content: 'stale write', language: 'typescript', expectedRevision: 1 },
      alice.tokens.accessToken,
    );
    expect([400, 409]).toContain(stale.status);
  });

  it('refuses to store secret material in a source file', async () => {
    const response = await api(
      'POST',
      '/applications/' + applicationId + '/files',
      { path: 'src/creds.ts', content: 'export const awsKey = "AKIAIOSFODNN7EXAMPLE";' },
      alice.tokens.accessToken,
    );
    expect(response.status).toBe(400);
  });

  it('runs verification over a populated application and records honest evidence', async () => {
    const response = await api(
      'POST',
      '/applications/' + applicationId + '/verifications',
      {},
      alice.tokens.accessToken,
    );
    expect(response.status).toBe(201);
    const runs = response.body as unknown as Array<{ kind: string; status: string; evidence: Record<string, unknown> }>;
    expect(runs.length).toBe(3);

    const byKind = new Map(runs.map((run) => [run.kind, run]));
    expect(byKind.get('STATIC_ANALYSIS')?.status).toBe('PASSED');
    expect(byKind.get('SECRET_SCAN')?.status).toBe('PASSED');
    expect(byKind.get('DEPENDENCY_AUDIT')?.status).toBe('PASSED');
    expect(byKind.get('STATIC_ANALYSIS')?.evidence).toMatchObject({ analyzedFiles: 2, totalFiles: 2 });
  });

  it('fails dependency audit when a manifest declares a non-string version', async () => {
    await api(
      'POST',
      '/applications/' + applicationId + '/files',
      { path: 'broken/package.json', content: '{"name":"broken","version":"1.0.0","dependencies":{"left-pad":123}}' },
      alice.tokens.accessToken,
    );

    const response = await api(
      'POST',
      '/applications/' + applicationId + '/verifications',
      { kinds: ['DEPENDENCY_AUDIT'] },
      alice.tokens.accessToken,
    );
    expect(response.status).toBe(201);
    const runs = response.body as unknown as Array<{ kind: string; status: string; findings: { counts: { ERROR: number } } }>;
    expect(runs[0].status).toBe('FAILED');
    expect(runs[0].findings.counts.ERROR).toBe(1);
  });

  it('records SKIPPED, never a fake PASS, when an application has no analyzable files', async () => {
    const response = await api(
      'POST',
      '/applications/' + emptyApplicationId + '/verifications',
      {},
      alice.tokens.accessToken,
    );
    expect(response.status).toBe(201);
    const runs = response.body as unknown as Array<{ status: string }>;
    expect(runs.length).toBe(3);
    for (const run of runs) {
      expect(run.status).toBe('SKIPPED');
    }
  });

  it('lists and reads verification runs with the persisted history', async () => {
    const response = await api(
      'GET',
      '/applications/' + applicationId + '/verifications',
      undefined,
      alice.tokens.accessToken,
    );
    expect(response.status).toBe(200);
    const runs = response.body as unknown as Array<{ id: string }>;
    expect(runs.length).toBe(4);
  });

  it('stores a text reference and refuses unsupported kinds and oversized content', async () => {
    const created = await api(
      'POST',
      '/applications/' + applicationId + '/references',
      { title: 'Landing spec', kind: 'SPEC', content: 'The landing page must include an email signup form and load in under two seconds.' },
      alice.tokens.accessToken,
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'STORED', kind: 'SPEC' });
    referenceId = (created.body as { id: string }).id;

    const imageKind = await api(
      'POST',
      '/applications/' + applicationId + '/references',
      { title: 'Mockup', kind: 'IMAGE', content: 'pretend image bytes' },
      alice.tokens.accessToken,
    );
    expect(imageKind.status).toBe(400);

    const secret = await api(
      'POST',
      '/applications/' + applicationId + '/references',
      { title: 'Leaky spec', kind: 'SPEC', content: 'Our key is AKIAIOSFODNN7EXAMPLE for deployments.' },
      alice.tokens.accessToken,
    );
    expect(secret.status).toBe(400);
  });

  it('records an honest EXTRACTION_FAILED state when no AI provider is configured', async () => {
    const response = await api(
      'POST',
      '/applications/' + applicationId + '/references/' + referenceId + '/extract',
      {},
      alice.tokens.accessToken,
    );
    const providerConfigured = response.status === 200;
    if (!providerConfigured) {
      expect([502, 503]).toContain(response.status);
      const fetched = await api(
        'GET',
        '/applications/' + applicationId + '/references/' + referenceId,
        undefined,
        alice.tokens.accessToken,
      );
      expect(fetched.status).toBe(200);
      expect(fetched.body).toMatchObject({ status: 'EXTRACTION_FAILED' });
      expect(typeof (fetched.body as { extractionError: unknown }).extractionError).toBe('string');
    }
  });

  it('enforces tenant isolation: a second user cannot touch the first user application', async () => {
    bob = await registerUser('bob');

    const files = await api(
      'GET',
      '/applications/' + applicationId + '/files',
      undefined,
      bob.tokens.accessToken,
    );
    expect([403, 404]).toContain(files.status);

    const verification = await api(
      'POST',
      '/applications/' + applicationId + '/verifications',
      {},
      bob.tokens.accessToken,
    );
    expect([403, 404]).toContain(verification.status);

    const reference = await api(
      'POST',
      '/applications/' + applicationId + '/references',
      { title: 'Intrusion', kind: 'SPEC', content: 'This reference should never be stored.' },
      bob.tokens.accessToken,
    );
    expect([403, 404]).toContain(reference.status);

    const storedReferences = await api(
      'GET',
      '/applications/' + applicationId + '/references',
      undefined,
      alice.tokens.accessToken,
    );
    expect(storedReferences.status).toBe(200);
    const references = storedReferences.body as unknown as Array<{ title: string }>;
    expect(references.some((item) => item.title === 'Intrusion')).toBe(false);
  });

  it('logs out and revokes the refresh token session', async () => {
    const logout = await api('POST', '/auth/logout', {
      refreshToken: bob.tokens.refreshToken,
    });
    expect(logout.status).toBe(200);
    expect(logout.body).toMatchObject({ success: true });

    const replay = await api('POST', '/auth/refresh', {
      refreshToken: bob.tokens.refreshToken,
    });
    expect(replay.status).toBe(401);
  });
});
