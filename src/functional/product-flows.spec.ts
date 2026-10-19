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
  let carol: UserContext;
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
    const oldRefreshToken = alice.tokens.refreshToken;
    const refreshed = await api('POST', '/auth/refresh', {
      refreshToken: oldRefreshToken,
    });
    expect(refreshed.status).toBe(200);
    expect(typeof refreshed.body.refreshToken).toBe('string');
    expect(refreshed.body.refreshToken).not.toBe(oldRefreshToken);
    alice.tokens = {
      accessToken: refreshed.body.accessToken as string,
      refreshToken: refreshed.body.refreshToken as string,
    };

    const replay = await api('POST', '/auth/refresh', {
      refreshToken: oldRefreshToken,
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

  it('blocks deployment readiness honestly for an empty application', async () => {
    const response = await api(
      'GET',
      '/applications/' + emptyApplicationId + '/deployments/readiness',
      undefined,
      alice.tokens.accessToken,
    );
    expect(response.status).toBe(200);
    const report = response.body as { verdict: string; checks: Array<{ code: string; status: string }> };
    expect(report.verdict).toBe('BLOCKED');
    expect(report.checks.some((check) => check.code === 'readiness.empty-application' && check.status === 'FAIL')).toBe(true);
  });

  it('refuses to record a deployment when the latest verification failed', async () => {
    const response = await api(
      'POST',
      '/applications/' + applicationId + '/deployments',
      { environment: 'STAGING' },
      alice.tokens.accessToken,
    );
    expect(response.status).toBe(400);
    const body = response.body as { readiness?: { verdict: string } };
    expect(body.readiness?.verdict).toBe('BLOCKED');
  });

  it('records an honest deployment intent for a clean, verified application', async () => {
    const created = await api(
      'POST',
      '/projects/' + projectId + '/applications',
      { name: 'Deployable App' },
      alice.tokens.accessToken,
    );
    expect(created.status).toBe(201);
    const deployableId = (created.body as { id: string }).id;

    const page = await api(
      'POST',
      '/applications/' + deployableId + '/files',
      { path: 'index.html', content: '<!doctype html><html><body><h1>Deployable</h1></body></html>' },
      alice.tokens.accessToken,
    );
    expect(page.status).toBe(201);

    const verified = await api(
      'POST',
      '/applications/' + deployableId + '/verifications',
      {},
      alice.tokens.accessToken,
    );
    expect(verified.status).toBe(201);

    const deployment = await api(
      'POST',
      '/applications/' + deployableId + '/deployments',
      { environment: 'PREVIEW' },
      alice.tokens.accessToken,
    );
    expect(deployment.status).toBe(201);
    const record = deployment.body as {
      environment: string;
      status: string;
      metadata: { readiness: { verdict: string }; adapter: string; executionNote: string };
    };
    expect(record.environment).toBe('PREVIEW');
    expect(record.status).toBe('READY');
    expect(record.metadata.readiness.verdict).toBe('READY');
    expect(record.metadata.adapter).toBe('none-configured');
    expect(record.metadata.executionNote).toContain('does not claim execution');

    const listed = await api(
      'GET',
      '/applications/' + deployableId + '/deployments',
      undefined,
      alice.tokens.accessToken,
    );
    expect(listed.status).toBe(200);
    expect((listed.body as unknown as Array<{ id: string }>).length).toBe(1);
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

  it('adds members to the organization and refuses duplicates, unknown accounts, and non-admin actors', async () => {
    carol = await registerUser('carol');

    const added = await api(
      'POST',
      '/organizations/' + organizationId + '/members',
      { email: bob.email, role: 'DEVELOPER' },
      alice.tokens.accessToken,
    );
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ role: 'DEVELOPER' });

    const duplicate = await api(
      'POST',
      '/organizations/' + organizationId + '/members',
      { email: bob.email, role: 'DEVELOPER' },
      alice.tokens.accessToken,
    );
    expect(duplicate.status).toBe(409);

    const unknown = await api(
      'POST',
      '/organizations/' + organizationId + '/members',
      { email: 'no-such-account-' + runId + '@example.com', role: 'VIEWER' },
      alice.tokens.accessToken,
    );
    expect(unknown.status).toBe(404);

    const bobTries = await api(
      'POST',
      '/organizations/' + organizationId + '/members',
      { email: carol.email, role: 'VIEWER' },
      bob.tokens.accessToken,
    );
    expect(bobTries.status).toBe(404);
  });

  it('changes member roles but protects the last owner and refuses owner assignment', async () => {
    const members = await api(
      'GET',
      '/organizations/' + organizationId + '/members',
      undefined,
      alice.tokens.accessToken,
    );
    expect(members.status).toBe(200);
    const list = members.body as unknown as Array<{ id: string; role: string; user: { email: string } }>;
    const bobMembership = list.find((member) => member.user.email === bob.email);
    const aliceMembership = list.find((member) => member.user.email === alice.email);
    expect(bobMembership).toBeDefined();
    expect(aliceMembership).toBeDefined();

    const ownerAttempt = await api(
      'PATCH',
      '/organizations/' + organizationId + '/members/' + bobMembership!.id,
      { role: 'OWNER' },
      alice.tokens.accessToken,
    );
    expect(ownerAttempt.status).toBe(400);

    const promoted = await api(
      'PATCH',
      '/organizations/' + organizationId + '/members/' + bobMembership!.id,
      { role: 'ADMIN' },
      alice.tokens.accessToken,
    );
    expect(promoted.status).toBe(200);
    expect(promoted.body).toMatchObject({ role: 'ADMIN' });

    const lastOwner = await api(
      'PATCH',
      '/organizations/' + organizationId + '/members/' + aliceMembership!.id,
      { role: 'ADMIN' },
      alice.tokens.accessToken,
    );
    expect(lastOwner.status).toBe(400);

    const unknownMembership = await api(
      'PATCH',
      '/organizations/' + organizationId + '/members/nonexistent-membership-id',
      { role: 'DEVELOPER' },
      alice.tokens.accessToken,
    );
    expect(unknownMembership.status).toBe(404);

    const bobAddsAsAdmin = await api(
      'POST',
      '/organizations/' + organizationId + '/members',
      { email: carol.email, role: 'VIEWER' },
      bob.tokens.accessToken,
    );
    expect(bobAddsAsAdmin.status).toBe(201);
  });

  it('exposes the audit trail to admins only and records the real actions', async () => {
    const denied = await api(
      'GET',
      '/organizations/' + organizationId + '/audit-events',
      undefined,
      carol.tokens.accessToken,
    );
    expect(denied.status).toBe(404);

    const trail = await api(
      'GET',
      '/organizations/' + organizationId + '/audit-events',
      undefined,
      alice.tokens.accessToken,
    );
    expect(trail.status).toBe(200);
    const events = trail.body as unknown as Array<{ action: string; outcome: string }>;
    const actions = events.map((event) => event.action);
    expect(actions).toContain('organization.member.add');
    expect(actions).toContain('organization.member.role.change');
    expect(events.every((event) => event.outcome === 'SUCCESS')).toBe(true);
  });

  it('transfers ownership atomically and protects the new single owner', async () => {
    const members = await api(
      'GET',
      '/organizations/' + organizationId + '/members',
      undefined,
      alice.tokens.accessToken,
    );
    const list = members.body as unknown as Array<{ id: string; role: string; user: { email: string } }>;
    const bobMembership = list.find((member) => member.user.email === bob.email);

    const transferred = await api(
      'POST',
      '/organizations/' + organizationId + '/ownership-transfer',
      { memberId: bobMembership!.id },
      alice.tokens.accessToken,
    );
    expect(transferred.status).toBe(201);
    expect(transferred.body).toMatchObject({ previousOwnerId: alice.userId, newOwnerId: bob.userId });

    const afterTransfer = await api(
      'GET',
      '/organizations/' + organizationId + '/members',
      undefined,
      alice.tokens.accessToken,
    );
    const updated = afterTransfer.body as unknown as Array<{ role: string; user: { email: string } }>;
    expect(updated.find((member) => member.user.email === bob.email)?.role).toBe('OWNER');
    expect(updated.find((member) => member.user.email === alice.email)?.role).toBe('ADMIN');

    const selfTransfer = await api(
      'POST',
      '/organizations/' + organizationId + '/ownership-transfer',
      { memberId: bobMembership!.id },
      bob.tokens.accessToken,
    );
    expect(selfTransfer.status).toBe(400);

    const nonMember = await api(
      'POST',
      '/organizations/' + organizationId + '/ownership-transfer',
      { memberId: 'nonexistent-membership-id' },
      bob.tokens.accessToken,
    );
    expect(nonMember.status).toBe(404);
  });

  it('removes members but never allows direct owner removal', async () => {
    const members = await api(
      'GET',
      '/organizations/' + organizationId + '/members',
      undefined,
      alice.tokens.accessToken,
    );
    const list = members.body as unknown as Array<{ id: string; role: string; user: { email: string } }>;
    const carolMembership = list.find((member) => member.user.email === carol.email);
    const bobMembership = list.find((member) => member.user.email === bob.email);

    const removed = await api(
      'DELETE',
      '/organizations/' + organizationId + '/members/' + carolMembership!.id,
      undefined,
      bob.tokens.accessToken,
    );
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ removed: true });

    const again = await api(
      'DELETE',
      '/organizations/' + organizationId + '/members/' + carolMembership!.id,
      undefined,
      bob.tokens.accessToken,
    );
    expect(again.status).toBe(404);

    const ownerRemoval = await api(
      'DELETE',
      '/organizations/' + organizationId + '/members/' + bobMembership!.id,
      undefined,
      bob.tokens.accessToken,
    );
    expect(ownerRemoval.status).toBe(400);
  });

  it('updates application details and refuses updates to unknown applications', async () => {
    const updated = await api(
      'PATCH',
      '/projects/' + projectId + '/applications/' + applicationId,
      { framework: 'next', runtime: 'edge' },
      alice.tokens.accessToken,
    );
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: 'Functional App', framework: 'next', runtime: 'edge' });

    const unknown = await api(
      'PATCH',
      '/projects/' + projectId + '/applications/nonexistent-application-id',
      { framework: 'next' },
      alice.tokens.accessToken,
    );
    expect(unknown.status).toBe(404);
  });

  it('archives an application, blocks writes while archived, and restores it', async () => {
    const archived = await api(
      'POST',
      '/projects/' + projectId + '/applications/' + emptyApplicationId + '/archive',
      {},
      alice.tokens.accessToken,
    );
    expect(archived.status).toBe(201);
    expect(archived.body).toMatchObject({ status: 'ARCHIVED' });

    const blockedWrite = await api(
      'POST',
      '/applications/' + emptyApplicationId + '/files',
      { path: 'src/blocked.ts', content: 'export const blocked = true;', language: 'typescript' },
      alice.tokens.accessToken,
    );
    expect(blockedWrite.status).toBe(404);

    const readableWhileArchived = await api(
      'GET',
      '/applications/' + emptyApplicationId + '/deployments/readiness',
      undefined,
      alice.tokens.accessToken,
    );
    expect(readableWhileArchived.status).toBe(200);

    const hiddenFromList = await api(
      'GET',
      '/projects/' + projectId + '/applications',
      undefined,
      alice.tokens.accessToken,
    );
    const listed = hiddenFromList.body as unknown as Array<{ id: string }>;
    expect(listed.some((item) => item.id === emptyApplicationId)).toBe(false);

    const restored = await api(
      'POST',
      '/projects/' + projectId + '/applications/' + emptyApplicationId + '/restore',
      {},
      alice.tokens.accessToken,
    );
    expect(restored.status).toBe(201);
    expect(restored.body).toMatchObject({ status: 'PLANNING' });

    const writeAfterRestore = await api(
      'POST',
      '/applications/' + emptyApplicationId + '/files',
      { path: 'src/unblocked.ts', content: 'export const unblocked = true;', language: 'typescript' },
      alice.tokens.accessToken,
    );
    expect(writeAfterRestore.status).toBe(201);
  });

  it('archives a project, blocking new applications, and restores it', async () => {
    const scratch = await api(
      'POST',
      '/workspaces/' + workspaceId + '/projects',
      { name: 'Lifecycle Scratch Project' },
      alice.tokens.accessToken,
    );
    expect(scratch.status).toBe(201);
    const scratchId = (scratch.body as { id: string }).id;

    const archived = await api(
      'POST',
      '/projects/' + scratchId + '/archive',
      {},
      alice.tokens.accessToken,
    );
    expect(archived.status).toBe(201);
    expect(archived.body).toMatchObject({ status: 'ARCHIVED' });

    const blocked = await api(
      'POST',
      '/projects/' + scratchId + '/applications',
      { name: 'Blocked App' },
      alice.tokens.accessToken,
    );
    expect(blocked.status).toBe(404);

    const restored = await api(
      'POST',
      '/projects/' + scratchId + '/restore',
      {},
      alice.tokens.accessToken,
    );
    expect(restored.status).toBe(201);
    expect(restored.body).toMatchObject({ status: 'ACTIVE' });

    const allowed = await api(
      'POST',
      '/projects/' + scratchId + '/applications',
      { name: 'Unblocked App' },
      alice.tokens.accessToken,
    );
    expect(allowed.status).toBe(201);
  });

  it('checkpoints an application and restores the exact earlier state atomically', async () => {
    const created = await api(
      'POST',
      '/projects/' + projectId + '/applications',
      { name: 'Checkpointed App' },
      alice.tokens.accessToken,
    );
    expect(created.status).toBe(201);
    const checkpointedId = (created.body as { id: string }).id;

    const first = await api(
      'POST',
      '/applications/' + checkpointedId + '/files',
      { path: 'a.ts', content: 'export const value = 1;', language: 'typescript' },
      alice.tokens.accessToken,
    );
    expect(first.status).toBe(201);
    const second = await api(
      'POST',
      '/applications/' + checkpointedId + '/files',
      { path: 'b.ts', content: 'export const other = 2;', language: 'typescript' },
      alice.tokens.accessToken,
    );
    expect(second.status).toBe(201);

    const blankLabel = await api(
      'POST',
      '/applications/' + checkpointedId + '/checkpoints',
      { label: '   ' },
      alice.tokens.accessToken,
    );
    expect(blankLabel.status).toBe(400);

    const checkpoint = await api(
      'POST',
      '/applications/' + checkpointedId + '/checkpoints',
      { label: 'stable' },
      alice.tokens.accessToken,
    );
    expect(checkpoint.status).toBe(201);
    expect(checkpoint.body).toMatchObject({ label: 'stable', fileCount: 2 });
    const checkpointId = (checkpoint.body as { id: string }).id;

    const mutated = await api(
      'POST',
      '/applications/' + checkpointedId + '/files',
      { path: 'a.ts', content: 'export const value = 999;', language: 'typescript', expectedRevision: 1 },
      alice.tokens.accessToken,
    );
    expect(mutated.status).toBe(201);
    const extra = await api(
      'POST',
      '/applications/' + checkpointedId + '/files',
      { path: 'c.ts', content: 'export const added = 3;', language: 'typescript' },
      alice.tokens.accessToken,
    );
    expect(extra.status).toBe(201);

    const restored = await api(
      'POST',
      '/applications/' + checkpointedId + '/checkpoints/' + checkpointId + '/restore',
      {},
      alice.tokens.accessToken,
    );
    expect(restored.status).toBe(201);
    expect(restored.body).toMatchObject({ changedFiles: 2, atomic: true });

    const files = await api(
      'GET',
      '/applications/' + checkpointedId + '/files',
      undefined,
      alice.tokens.accessToken,
    );
    expect(files.status).toBe(200);
    const currentFiles = files.body as unknown as Array<{ id: string; path: string; revision: number }>;
    const fileA = currentFiles.find((file) => file.path === 'a.ts');
    expect(fileA?.revision).toBe(3);
    expect(currentFiles.length).toBe(2);
    expect(currentFiles.some((file) => file.path === 'c.ts')).toBe(false);

    const fileRead = await api(
      'GET',
      '/applications/' + checkpointedId + '/files/' + fileA!.id,
      undefined,
      alice.tokens.accessToken,
    );
    expect(fileRead.status).toBe(200);
    expect((fileRead.body as { content: string }).content).toBe('export const value = 1;');

    const bogus = await api(
      'POST',
      '/applications/' + checkpointedId + '/checkpoints/nonexistent-checkpoint-id/restore',
      {},
      alice.tokens.accessToken,
    );
    expect(bogus.status).toBe(404);
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
