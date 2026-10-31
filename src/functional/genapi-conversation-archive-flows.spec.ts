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
 * Key-authenticated conversation archives against the real app and
 * the real CI PostgreSQL. Grounded in the GitHub conversation lock:
 * write access is required to lock an issue, a locked conversation
 * blocks later comments, and repeat locks succeed. The keyed archive
 * mirrors the JWT archive exactly - same response shape, same honest
 * archived 409 for later message writes, no audit row - and the
 * writable application bound plus the conversation ownership check
 * answer foreign, cross-application, and unknown ids with uniform
 * 404s that never leak what exists in other tenants.
 */
suite('GENESIS genapi conversation archive flows (real app, real database)', () => {
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
  let applicationCId: string;
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
    const email = 'genesis-convarc-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'conversation-archive-password-123',
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
    const response = await api(
      'POST',
      '/workspaces/' + workspaceId + '/projects',
      { name },
      token,
    );
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  };

  const createApplication = async (token: string, projectId: string, name: string) => {
    const response = await api(
      'POST',
      '/projects/' + projectId + '/applications',
      { name },
      token,
    );
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  };

  const createKeyedConversation = async (applicationId: string, title: string) =>
    api(
      'POST',
      '/genapi/applications/' + applicationId + '/conversations',
      { title },
      writerKey.key,
    );

  const keyedArchive = async (
    applicationId: string,
    conversationId: string,
    key?: string,
  ) =>
    api(
      'POST',
      '/genapi/applications/' + applicationId + '/conversations/' + conversationId + '/archive',
      {},
      key,
    );

  const archivedAtOf = async (conversationId: string) => {
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

    mainProjectId = await createProject(hank.tokens.accessToken, workspaceAId, 'Archive Project ' + runId);
    const foreignProjectId = await createProject(iris.tokens.accessToken, foreignWorkspaceId, 'Foreign Archive Project ' + runId);

    applicationAId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Archive App A ' + runId);
    applicationBId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Archive App B ' + runId);
    applicationCId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Archive App C ' + runId);
    foreignApplicationId = await createApplication(iris.tokens.accessToken, foreignProjectId, 'Foreign Archive App ' + runId);

    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'Archive Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
    readerKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Archive Reader',
      ['READ_APPLICATIONS'],
    );
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Archive Short Lived',
      ['WRITE_APPLICATIONS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Archive Revoked',
      ['WRITE_APPLICATIONS'],
    );
    irisWriter = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Foreign Archive Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
  });
  it('archives a keyed conversation that mirrors the JWT response shape exactly', async () => {
    const keyedCreate = await createKeyedConversation(applicationAId, 'Keyed archive probe ' + runId);
    expect(keyedCreate.status).toBe(201);
    const keyedConversationId = (keyedCreate.body as { id: string }).id;

    const jwtCreate = await api('POST', '/applications/' + applicationAId + '/conversations', { title: 'JWT archive probe ' + runId }, hank.tokens.accessToken);
    expect(jwtCreate.status).toBe(201);
    const jwtConversationId = (jwtCreate.body as { id: string }).id;

    const keyed = await keyedArchive(applicationAId, keyedConversationId, writerKey.key);
    expect(keyed.status).toBe(201);
    expect((keyed.body as { archivedAt: string | null }).archivedAt).not.toBeNull();
    expect(Object.keys(keyed.body).sort()).toEqual(['archivedAt', 'id', 'title']);

    const jwt = await api('PATCH', '/conversations/' + jwtConversationId + '/archive', {}, hank.tokens.accessToken);
    expect(jwt.status).toBe(200);
    expect((jwt.body as { archivedAt: string | null }).archivedAt).not.toBeNull();
    expect(Object.keys(jwt.body).sort()).toEqual(['archivedAt', 'id', 'title']);
  });
  it('blocks later message writes on both surfaces with the honest archived 409', async () => {
    const created = await createKeyedConversation(applicationAId, 'Archived 409 probe ' + runId);
    expect(created.status).toBe(201);
    const conversationId = (created.body as { id: string }).id;
    const archived = await keyedArchive(applicationAId, conversationId, writerKey.key);
    expect(archived.status).toBe(201);

    const keyedMessage = await api('POST', '/genapi/applications/' + applicationAId + '/conversations/' + conversationId + '/messages', { content: 'Keyed message after archive' }, writerKey.key);
    expect(keyedMessage.status).toBe(409);
    expect((keyedMessage.body as { message: string }).message).toBe('This conversation is archived or unavailable.');

    const jwtMessage = await api('POST', '/conversations/' + conversationId + '/messages', { content: 'JWT message after archive' }, hank.tokens.accessToken);
    expect(jwtMessage.status).toBe(409);
    expect((jwtMessage.body as { message: string }).message).toBe('This conversation is archived or unavailable.');
    expect(await prisma.message.count({ where: { conversationId } })).toBe(0);
  });
  it('answers a double-tap with two honest archive stamps on one row', async () => {
    const created = await createKeyedConversation(applicationAId, 'Double tap archive probe ' + runId);
    expect(created.status).toBe(201);
    const conversationId = (created.body as { id: string }).id;

    const raced = await Promise.all([
      keyedArchive(applicationAId, conversationId, writerKey.key),
      keyedArchive(applicationAId, conversationId, writerKey.key),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 201]);
    // Two concurrent archive stamps are both honest: the requests may
    // execute in either order on the server, so the only honest law
    // is that each response carries a real stamp and the stored row
    // ends at exactly one of the two stamped values.
    const stamps = raced.map(
      (response) => new Date((response.body as { archivedAt: string }).archivedAt).getTime(),
    );
    expect(stamps.every((stamp) => !Number.isNaN(stamp))).toBe(true);
    const stored = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { archivedAt: true },
    });
    const finalStamp = stored && stored.archivedAt ? stored.archivedAt.getTime() : NaN;
    expect(Number.isNaN(finalStamp)).toBe(false);
    expect(stamps).toContain(finalStamp);
    expect(await prisma.conversation.count({ where: { id: conversationId } })).toBe(1);
  });
  it('writes no audit rows for keyed or JWT archives', async () => {
    const before = await prisma.auditEvent.count({ where: { organizationId } });
    const created = await createKeyedConversation(applicationAId, 'Audit parity probe ' + runId);
    expect(created.status).toBe(201);
    const conversationId = (created.body as { id: string }).id;
    expect(await prisma.auditEvent.count({ where: { organizationId } })).toBe(before);

    const keyed = await keyedArchive(applicationAId, conversationId, writerKey.key);
    expect(keyed.status).toBe(201);
    const jwt = await api('PATCH', '/conversations/' + conversationId + '/archive', {}, hank.tokens.accessToken);
    expect(jwt.status).toBe(200);

    // neither surface writes an audit row for a conversation
    // archive, so the organization trail stays unchanged.
    expect(await prisma.auditEvent.count({ where: { organizationId } })).toBe(before);
  });
  it('tenant-bounds the archive with two uniform 404s and no stamp', async () => {
    const created = await createKeyedConversation(applicationAId, 'Tenant bound probe ' + runId);
    expect(created.status).toBe(201);
    const conversationId = (created.body as { id: string }).id;

    const foreignCreate = await api('POST', '/genapi/applications/' + foreignApplicationId + '/conversations', { title: 'Foreign archive probe ' + runId }, irisWriter.key);
    expect(foreignCreate.status).toBe(201);
    const foreignConversationId = (foreignCreate.body as { id: string }).id;

    const applicationMessages = new Set<string>();
    const conversationMessages = new Set<string>();

    const unknownApplication = await keyedArchive('does-not-exist-at-all', conversationId, writerKey.key);
    expect(unknownApplication.status).toBe(404);
    applicationMessages.add((unknownApplication.body as { message: string }).message);

    const foreignApplication = await keyedArchive(foreignApplicationId, foreignConversationId, writerKey.key);
    expect(foreignApplication.status).toBe(404);
    applicationMessages.add((foreignApplication.body as { message: string }).message);

    const foreignKey = await keyedArchive(applicationAId, conversationId, irisWriter.key);
    expect(foreignKey.status).toBe(404);
    applicationMessages.add((foreignKey.body as { message: string }).message);

    const unknownConversation = await keyedArchive(applicationAId, 'does-not-exist-at-all', writerKey.key);
    expect(unknownConversation.status).toBe(404);
    conversationMessages.add((unknownConversation.body as { message: string }).message);

    const crossApplication = await keyedArchive(applicationBId, conversationId, writerKey.key);
    expect(crossApplication.status).toBe(404);
    conversationMessages.add((crossApplication.body as { message: string }).message);

    expect(applicationMessages.size).toBe(1);
    expect(Array.from(applicationMessages)[0]).toBe('Application not found.');
    expect(conversationMessages.size).toBe(1);
    expect(Array.from(conversationMessages)[0]).toBe('Conversation not found.');
    expect(await archivedAtOf(conversationId)).toBeNull();
    expect(await archivedAtOf(foreignConversationId)).toBeNull();
  });
  it('races a keyed archive against a JWT archive into one clean archived end state', async () => {
    const created = await createKeyedConversation(applicationCId, 'Two actor race probe ' + runId);
    expect(created.status).toBe(201);
    const conversationId = (created.body as { id: string }).id;

    const raced = await Promise.all([
      keyedArchive(applicationCId, conversationId, writerKey.key),
      api('PATCH', '/conversations/' + conversationId + '/archive', {}, hank.tokens.accessToken),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(await archivedAtOf(conversationId)).not.toBeNull();
    expect(await prisma.conversation.count({ where: { id: conversationId } })).toBe(1);
  });
  it('stays clean when a keyed archive races a keyed message write', async () => {
    const created = await createKeyedConversation(applicationAId, 'Message race probe ' + runId);
    expect(created.status).toBe(201);
    const conversationId = (created.body as { id: string }).id;

    const raced = await Promise.all([
      keyedArchive(applicationAId, conversationId, writerKey.key),
      api('POST', '/genapi/applications/' + applicationAId + '/conversations/' + conversationId + '/messages', { content: 'Message racing the archive' }, writerKey.key),
    ]);
    expect(raced[0].status).toBe(201);
    expect([201, 409]).toContain(raced[1].status);
    if (raced[1].status === 409) {
      expect((raced[1].body as { message: string }).message).toBe('This conversation is archived or unavailable.');
      expect(await prisma.message.count({ where: { conversationId } })).toBe(0);
    } else {
      expect(await prisma.message.count({ where: { conversationId } })).toBe(1);
    }
    expect(await archivedAtOf(conversationId)).not.toBeNull();
  });
  it('refuses a read-only key with one message and no stamp', async () => {
    const created = await createKeyedConversation(applicationAId, 'Reader archive probe ' + runId);
    expect(created.status).toBe(201);
    const conversationId = (created.body as { id: string }).id;

    const refused = await keyedArchive(applicationAId, conversationId, readerKey.key);
    expect(refused.status).toBe(403);
    expect((refused.body as { message: string }).message).toBe('The API key does not grant the required scope.');
    expect(await archivedAtOf(conversationId)).toBeNull();
  });
  it('refuses archives on archived applications with the same uniform 404', async () => {
    const created = await createKeyedConversation(applicationBId, 'Archived application probe ' + runId);
    expect(created.status).toBe(201);
    const conversationId = (created.body as { id: string }).id;

    const archiveApplication = await api('POST', '/projects/' + mainProjectId + '/applications/' + applicationBId + '/archive', {}, hank.tokens.accessToken);
    expect(archiveApplication.status).toBe(201);

    const refused = await keyedArchive(applicationBId, conversationId, writerKey.key);
    expect(refused.status).toBe(404);
    expect((refused.body as { message: string }).message).toBe('Application not found.');
    expect(await archivedAtOf(conversationId)).toBeNull();
  });
  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const created = await createKeyedConversation(applicationAId, 'Lifecycle probe ' + runId);
    expect(created.status).toBe(201);
    const conversationId = (created.body as { id: string }).id;

    const revoke = await api('POST', '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke', {}, hank.tokens.accessToken);
    expect([200, 201]).toContain(revoke.status);

    const revokedPost = await keyedArchive(applicationAId, conversationId, revokedKey.key);
    expect(revokedPost.status).toBe(401);
    expect((revokedPost.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredPost = await keyedArchive(applicationAId, conversationId, shortLivedKey.key);
    expect(expiredPost.status).toBe(401);
    expect((expiredPost.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const unauthenticated = await keyedArchive(applicationAId, conversationId);
    expect(unauthenticated.status).toBe(401);
    expect((unauthenticated.body as { message: string }).message).toBe('A valid GENESIS API key is required.');
    expect(await archivedAtOf(conversationId)).toBeNull();
  });
});