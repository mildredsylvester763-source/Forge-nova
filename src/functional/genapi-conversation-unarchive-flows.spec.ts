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
 * Key-authenticated conversation unarchive against the real app and
 * the real CI PostgreSQL. Grounded in the market leader: the GitHub
 * conversation unlock, where write access is required to unlock an
 * issue and repeat unlocks succeed. The keyed unarchive mirrors the
 * JWT unarchive exactly - same cleared stamp, same response shape,
 * same no-audit-row law - and the writable application bound plus
 * the conversation ownership check answer foreign, cross-application,
 * and unknown ids with uniform 404s that never leak what exists in
 * other tenants. Unarchiving an unarchived conversation is an honest
 * idempotent success, exactly like the GitHub repeat unlock.
 */
suite('GENESIS genapi conversation unarchive flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId: string;
  let foreignOrganizationId: string;
  let mainProjectId: string;
  let applicationAId: string;
  let applicationBId: string;
  let foreignApplicationId: string;
  let writerKey: KeyContext;
  let readerKey: KeyContext;
  let shortLivedKey: KeyContext;
  let revokedKey: KeyContext;
  let irisWriter: KeyContext;
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
    const email = 'genesis-unarch-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'conversation-unarchive-password-123',
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
  ): Promise<KeyContext> => {
    const body: Record<string, unknown> = { name, scopes };
    if (expiresAt !== undefined) {
      body.expiresAt = expiresAt;
    }
    const response = await api('POST', '/organizations/' + orgId + '/api-keys', body, token);
    expect(response.status).toBe(201);
    const created = response.body as unknown as KeyContext;
    expect(created.key).toMatch(/^gn_live_[A-Za-z0-9_-]{43}$/);
    return created;
  };

  const createProject = async (token: string, workspaceId: string, name: string) => {
    const response = await api('POST', '/workspaces/' + workspaceId + '/projects', { name }, token);
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  };

  const createApplication = async (token: string, projectId: string, name: string) => {
    const response = await api('POST', '/projects/' + projectId + '/applications', { name }, token);
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  };

  const createConversation = async (token: string, applicationId: string, title: string) => {
    const response = await api('POST', '/applications/' + applicationId + '/conversations', { title }, token);
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  };

  const keyedArchive = (applicationId: string, conversationId: string, key: string) =>
    api(
      'POST',
      '/genapi/applications/' + applicationId + '/conversations/' + conversationId + '/archive',
      {},
      key,
    );

  const jwtArchive = (conversationId: string, token: string) =>
    api('PATCH', '/conversations/' + conversationId + '/archive', undefined, token);

  const keyedUnarchive = (applicationId: string, conversationId: string, key?: string) =>
    api(
      'POST',
      '/genapi/applications/' + applicationId + '/conversations/' + conversationId + '/unarchive',
      {},
      key,
    );

  const jwtUnarchive = (conversationId: string, token: string) =>
    api('PATCH', '/conversations/' + conversationId + '/unarchive', undefined, token);

  const keyedMessage = (applicationId: string, conversationId: string, content: string) =>
    api(
      'POST',
      '/genapi/applications/' + applicationId + '/conversations/' + conversationId + '/messages',
      { content },
      writerKey.key,
    );

  const jwtMessage = (conversationId: string, content: string) =>
    api('POST', '/conversations/' + conversationId + '/messages', { content }, hank.tokens.accessToken);

  const archivedAtInDatabase = async (conversationId: string) => {
    const row = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { archivedAt: true },
    });
    return row ? row.archivedAt : undefined;
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
    await app.close();
  });

  it('seeds two organizations, applications, and scoped keys', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankWorkspaces = await api('GET', '/workspaces', undefined, hank.tokens.accessToken);
    expect(hankWorkspaces.status).toBe(200);
    const workspaceAId = (hankWorkspaces.body as unknown as Array<{ id: string }>)[0].id;

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;
    expect(foreignOrganizationId).not.toBe(organizationId);

    const irisWorkspaces = await api('GET', '/workspaces', undefined, iris.tokens.accessToken);
    expect(irisWorkspaces.status).toBe(200);
    const foreignWorkspaceId = (irisWorkspaces.body as unknown as Array<{ id: string }>)[0].id;

    mainProjectId = await createProject(hank.tokens.accessToken, workspaceAId, 'Unarchive Project ' + runId);
    const foreignProjectId = await createProject(iris.tokens.accessToken, foreignWorkspaceId, 'Foreign Unarchive Project ' + runId);

    applicationAId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Unarchive App A ' + runId);
    applicationBId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Unarchive App B ' + runId);
    foreignApplicationId = await createApplication(iris.tokens.accessToken, foreignProjectId, 'Foreign Unarchive App ' + runId);

    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'Unarch Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
    readerKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Unarch Reader',
      ['READ_APPLICATIONS'],
    );
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Unarch Short Lived',
      ['WRITE_APPLICATIONS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Unarch Revoked',
      ['WRITE_APPLICATIONS'],
    );
    irisWriter = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Foreign Unarch Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
  });

  it('unarchives a keyed archived conversation and mirrors the JWT response shape exactly', async () => {
    const keyedConversationId = await createConversation(hank.tokens.accessToken, applicationAId, 'Keyed unarchive probe ' + runId);
    const jwtConversationId = await createConversation(hank.tokens.accessToken, applicationAId, 'JWT unarchive probe ' + runId);

    const archived = await keyedArchive(applicationAId, keyedConversationId, writerKey.key);
    expect(archived.status).toBe(201);
    expect(await archivedAtInDatabase(keyedConversationId)).not.toBeNull();

    const jwtArchived = await jwtArchive(jwtConversationId, hank.tokens.accessToken);
    expect(jwtArchived.status).toBe(200);
    expect(await archivedAtInDatabase(jwtConversationId)).not.toBeNull();

    const keyed = await keyedUnarchive(applicationAId, keyedConversationId, writerKey.key);
    expect(keyed.status).toBe(201);
    expect(Object.keys(keyed.body).sort()).toEqual(['archivedAt', 'id', 'title']);
    expect((keyed.body as { id: string }).id).toBe(keyedConversationId);
    expect((keyed.body as { archivedAt: string | null }).archivedAt).toBeNull();

    const jwt = await jwtUnarchive(jwtConversationId, hank.tokens.accessToken);
    expect(jwt.status).toBe(200);
    expect(Object.keys(jwt.body).sort()).toEqual(['archivedAt', 'id', 'title']);
    expect((jwt.body as { archivedAt: string | null }).archivedAt).toBeNull();

    expect(await archivedAtInDatabase(keyedConversationId)).toBeNull();
    expect(await archivedAtInDatabase(jwtConversationId)).toBeNull();
  });

  it('restores message writes on both surfaces after the unarchive', async () => {
    const conversationId = await createConversation(hank.tokens.accessToken, applicationAId, 'Message restore probe ' + runId);

    await keyedArchive(applicationAId, conversationId, writerKey.key);
    const blockedKeyed = await keyedMessage(applicationAId, conversationId, 'Blocked keyed probe');
    expect(blockedKeyed.status).toBe(409);

    const reopened = await keyedUnarchive(applicationAId, conversationId, writerKey.key);
    expect(reopened.status).toBe(201);
    const keyedPost = await keyedMessage(applicationAId, conversationId, 'Keyed probe after unarchive');
    expect(keyedPost.status).toBe(201);

    await jwtArchive(conversationId, hank.tokens.accessToken);
    const blockedJwt = await jwtMessage(conversationId, 'Blocked JWT probe');
    expect(blockedJwt.status).toBe(409);

    const jwtReopened = await jwtUnarchive(conversationId, hank.tokens.accessToken);
    expect(jwtReopened.status).toBe(200);
    const jwtPost = await jwtMessage(conversationId, 'JWT probe after unarchive');
    expect(jwtPost.status).toBe(201);
  });

  it('unarchives an unarchived conversation idempotently like the GitHub repeat unlock', async () => {
    const keyedConversationId = await createConversation(hank.tokens.accessToken, applicationAId, 'Repeat keyed probe ' + runId);
    const jwtConversationId = await createConversation(hank.tokens.accessToken, applicationAId, 'Repeat JWT probe ' + runId);

    const first = await keyedUnarchive(applicationAId, keyedConversationId, writerKey.key);
    expect(first.status).toBe(201);
    expect((first.body as { archivedAt: string | null }).archivedAt).toBeNull();
    const second = await keyedUnarchive(applicationAId, keyedConversationId, writerKey.key);
    expect(second.status).toBe(201);
    expect((second.body as { archivedAt: string | null }).archivedAt).toBeNull();

    const jwtFirst = await jwtUnarchive(jwtConversationId, hank.tokens.accessToken);
    expect(jwtFirst.status).toBe(200);
    expect((jwtFirst.body as { archivedAt: string | null }).archivedAt).toBeNull();

    expect(
      await prisma.conversation.count({
        where: { id: { in: [keyedConversationId, jwtConversationId] } },
      }),
    ).toBe(2);
  });

  it('writes zero audit rows for unarchives and refusals', async () => {
    const conversationId = await createConversation(hank.tokens.accessToken, applicationAId, 'Audit probe ' + runId);
    await keyedArchive(applicationAId, conversationId, writerKey.key);

    const before = await prisma.auditEvent.count({ where: { organizationId } });

    const reopened = await keyedUnarchive(applicationAId, conversationId, writerKey.key);
    expect(reopened.status).toBe(201);

    const refusedScope = await keyedUnarchive(applicationAId, conversationId, readerKey.key);
    expect(refusedScope.status).toBe(403);
    expect((refusedScope.body as { message: string }).message).toBe('The API key does not grant the required scope.');

    const refusedUnknown = await keyedUnarchive(applicationAId, 'does-not-exist-at-all', writerKey.key);
    expect(refusedUnknown.status).toBe(404);
    expect((refusedUnknown.body as { message: string }).message).toBe('Conversation not found.');

    const after = await prisma.auditEvent.count({ where: { organizationId } });
    expect(after).toBe(before);
  });

  it('tenant-bounds the unarchive with two uniform 404s', async () => {
    const ownConversationId = await createConversation(hank.tokens.accessToken, applicationAId, 'Tenant bound probe ' + runId);
    const foreignConversationId = await createConversation(iris.tokens.accessToken, foreignApplicationId, 'Foreign tenant probe ' + runId);

    const applicationMessages = new Set<string>();
    const conversationMessages = new Set<string>();

    const unknownApplication = await keyedUnarchive('does-not-exist-at-all', ownConversationId, writerKey.key);
    expect(unknownApplication.status).toBe(404);
    applicationMessages.add((unknownApplication.body as { message: string }).message);

    const foreignApplication = await keyedUnarchive(foreignApplicationId, foreignConversationId, writerKey.key);
    expect(foreignApplication.status).toBe(404);
    applicationMessages.add((foreignApplication.body as { message: string }).message);

    const foreignKey = await keyedUnarchive(applicationAId, ownConversationId, irisWriter.key);
    expect(foreignKey.status).toBe(404);
    applicationMessages.add((foreignKey.body as { message: string }).message);

    const unknownConversation = await keyedUnarchive(applicationAId, 'does-not-exist-at-all', writerKey.key);
    expect(unknownConversation.status).toBe(404);
    conversationMessages.add((unknownConversation.body as { message: string }).message);

    const crossApplication = await keyedUnarchive(applicationBId, ownConversationId, writerKey.key);
    expect(crossApplication.status).toBe(404);
    conversationMessages.add((crossApplication.body as { message: string }).message);

    expect(applicationMessages.size).toBe(1);
    expect(Array.from(applicationMessages)[0]).toBe('Application not found.');
    expect(conversationMessages.size).toBe(1);
    expect(Array.from(conversationMessages)[0]).toBe('Conversation not found.');
  });

  it('answers a double-tap with two clean idempotent successes on one row', async () => {
    const conversationId = await createConversation(hank.tokens.accessToken, applicationAId, 'Double tap probe ' + runId);
    await keyedArchive(applicationAId, conversationId, writerKey.key);

    const raced = await Promise.all([
      keyedUnarchive(applicationAId, conversationId, writerKey.key),
      keyedUnarchive(applicationAId, conversationId, writerKey.key),
    ]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(201);

    expect(await prisma.conversation.count({ where: { id: conversationId } })).toBe(1);
    expect(await archivedAtInDatabase(conversationId)).toBeNull();
  });

  it('races an archive against an unarchive into one clean final state', async () => {
    const conversationId = await createConversation(hank.tokens.accessToken, applicationAId, 'Archive race probe ' + runId);

    const raced = await Promise.all([
      keyedArchive(applicationAId, conversationId, writerKey.key),
      keyedUnarchive(applicationAId, conversationId, writerKey.key),
    ]);
    expect(raced[0].status).toBe(201);
    expect(raced[1].status).toBe(201);

    // The final state is whichever write committed last: an honest
    // archived stamp or an honest null, never a 500 and never a
    // corrupted row.
    const finalStamp = await archivedAtInDatabase(conversationId);
    expect(finalStamp === null || finalStamp instanceof Date).toBe(true);
    expect(await prisma.conversation.count({ where: { id: conversationId } })).toBe(1);
  });

  it('refuses a read-only key with one message', async () => {
    const conversationId = await createConversation(hank.tokens.accessToken, applicationAId, 'Reader probe ' + runId);

    const refused = await keyedUnarchive(applicationAId, conversationId, readerKey.key);
    expect(refused.status).toBe(403);
    expect((refused.body as { message: string }).message).toBe('The API key does not grant the required scope.');
  });

  it('refuses unarchives on archived applications with the same uniform 404', async () => {
    const conversationId = await createConversation(hank.tokens.accessToken, applicationBId, 'Archived application probe ' + runId);
    await keyedArchive(applicationBId, conversationId, writerKey.key);

    const archiveApplication = await api('POST', '/projects/' + mainProjectId + '/applications/' + applicationBId + '/archive', {}, hank.tokens.accessToken);
    expect(archiveApplication.status).toBe(201);

    const refused = await keyedUnarchive(applicationBId, conversationId, writerKey.key);
    expect(refused.status).toBe(404);
    expect((refused.body as { message: string }).message).toBe('Application not found.');
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const conversationId = await createConversation(hank.tokens.accessToken, applicationAId, 'Lifecycle probe ' + runId);
    await keyedArchive(applicationAId, conversationId, writerKey.key);

    const revoke = await api('POST', '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke', {}, hank.tokens.accessToken);
    expect([200, 201]).toContain(revoke.status);

    const revokedPost = await keyedUnarchive(applicationAId, conversationId, revokedKey.key);
    expect(revokedPost.status).toBe(401);
    expect((revokedPost.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredPost = await keyedUnarchive(applicationAId, conversationId, shortLivedKey.key);
    expect(expiredPost.status).toBe(401);
    expect((expiredPost.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const unauthenticated = await keyedUnarchive(applicationAId, conversationId);
    expect(unauthenticated.status).toBe(401);
    expect((unauthenticated.body as { message: string }).message).toBe('A valid GENESIS API key is required.');

    expect(await archivedAtInDatabase(conversationId)).not.toBeNull();
  });
});
