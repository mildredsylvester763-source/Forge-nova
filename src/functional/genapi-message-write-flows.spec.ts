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
 * Key-authenticated conversation message writes against the real app
 * and the real CI PostgreSQL. Grounded in the GitHub issue-comment
 * create: a token with write permission may post comments, and the
 * post is attributed to the token identity. The keyed message mirrors
 * the JWT message exactly - same response shape, same trim law, same
 * secret scan, same archived-conversation refusal - with the acting
 * key attributed in the stored message metadata so listings can show
 * which key posted it. The application tenant bound refuses foreign
 * and archived applications, and foreign, cross-application, and
 * unknown conversations all answer one uniform 404 per guard that
 * never leaks what exists in other tenants.
 */
suite('GENESIS genapi message write flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId: string;
  let foreignOrganizationId: string;
  let applicationAId: string;
  let applicationBId: string;
  let applicationCId: string;
  let foreignApplicationId: string;
  let mainConversationId: string;
  let crossConversationId: string;
  let archivedConversationId: string;
  let raceConversationId: string;
  let appCConversationId: string;
  let foreignConversationId: string;
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
    const email = 'genesis-msgnew-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'message-write-password-123',
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

  const createConversation = async (
    token: string,
    applicationId: string,
    title: string,
  ) => {
    const response = await api(
      'POST',
      '/applications/' + applicationId + '/conversations',
      { title },
      token,
    );
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  };

  const messageCount = (conversationId: string) =>
    prisma.message.count({ where: { conversationId } });

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

  it('seeds two organizations, applications, conversations, and scoped keys', async () => {
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

    const projectAId = await createProject(hank.tokens.accessToken, workspaceAId, 'Message Project ' + runId);
    const foreignProjectId = await createProject(iris.tokens.accessToken, foreignWorkspaceId, 'Foreign Message Project ' + runId);

    applicationAId = await createApplication(hank.tokens.accessToken, projectAId, 'Message App A ' + runId);
    applicationBId = await createApplication(hank.tokens.accessToken, projectAId, 'Message App B ' + runId);
    applicationCId = await createApplication(hank.tokens.accessToken, projectAId, 'Message App C ' + runId);
    foreignApplicationId = await createApplication(iris.tokens.accessToken, foreignProjectId, 'Foreign Message App ' + runId);

    mainConversationId = await createConversation(hank.tokens.accessToken, applicationAId, 'Main Conversation ' + runId);
    crossConversationId = await createConversation(hank.tokens.accessToken, applicationBId, 'Cross Conversation ' + runId);
    archivedConversationId = await createConversation(hank.tokens.accessToken, applicationAId, 'Archived Conversation ' + runId);
    raceConversationId = await createConversation(hank.tokens.accessToken, applicationAId, 'Race Conversation ' + runId);
    appCConversationId = await createConversation(hank.tokens.accessToken, applicationCId, 'App C Conversation ' + runId);
    foreignConversationId = await createConversation(iris.tokens.accessToken, foreignApplicationId, 'Foreign Conversation ' + runId);

    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'Message Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
    readerKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Message Reader',
      ['READ_APPLICATIONS'],
    );
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Message Short Lived',
      ['WRITE_APPLICATIONS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Message Revoked',
      ['WRITE_APPLICATIONS'],
    );
    irisWriter = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Foreign Message Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
  });

  it('writes a keyed message that mirrors the JWT response shape exactly', async () => {
    const before = await messageCount(mainConversationId);
    const keyed = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations/' + mainConversationId + '/messages',
      { content: '  Hello from the acting key  ' },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    const body = keyed.body as {
      id: string;
      conversationId: string;
      role: string;
      content: string;
      createdAt: string;
    };
    expect(body.conversationId).toBe(mainConversationId);
    expect(body.role).toBe('USER');
    expect(body.content).toBe('Hello from the acting key');
    expect(typeof body.createdAt).toBe('string');
    expect(Object.keys(keyed.body).sort()).toEqual(
      ['conversationId', 'content', 'createdAt', 'id', 'role'],
    );
    expect(await messageCount(mainConversationId)).toBe(before + 1);
  });

  it('attributes the message to the acting key and stays readable on both surfaces', async () => {
    const keyed = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations/' + mainConversationId + '/messages',
      { content: 'Attribution probe ' + runId },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    const createdId = (keyed.body as { id: string }).id;

    const truth = await prisma.message.findUnique({
      where: { id: createdId },
      select: { metadata: true, role: true, content: true },
    });
    expect(truth?.role).toBe('USER');
    expect(truth?.content).toBe('Attribution probe ' + runId);
    const metadata = truth?.metadata as {
      via?: string;
      apiKeyId?: string;
      apiKeyName?: string;
    };
    expect(metadata.via).toBe('genapi');
    expect(metadata.apiKeyId).toBe(writerKey.id);
    expect(metadata.apiKeyName).toBe('Message Writer');

    const keyedListing = await api(
      'GET',
      '/genapi/applications/' + applicationAId + '/conversations/' + mainConversationId + '/messages',
      undefined,
      writerKey.key,
    );
    expect(keyedListing.status).toBe(200);
    const keyedRows = keyedListing.body as unknown as Array<{
      id: string;
      metadata: { via?: string } | null;
    }>;
    const ownRow = keyedRows.find((row) => row.id === createdId);
    expect(ownRow?.metadata?.via).toBe('genapi');

    const jwtListing = await api(
      'GET',
      '/conversations/' + mainConversationId + '/messages',
      undefined,
      hank.tokens.accessToken,
    );
    expect(jwtListing.status).toBe(200);
    expect(
      (jwtListing.body as unknown as Array<{ id: string }>).some(
        (row) => row.id === createdId,
      ),
    ).toBe(true);
  });

  it('refuses secret material with the honest scanner before anything is stored', async () => {
    const before = await messageCount(mainConversationId);
    const refused = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations/' + mainConversationId + '/messages',
      { content: 'Our deploy key is AKIAIOSFODNN7EXAMPLE for today.' },
      writerKey.key,
    );
    expect(refused.status).toBe(400);
    expect(
      String((refused.body as { message: string }).message),
    ).toContain('Possible secret material detected');
    expect(await messageCount(mainConversationId)).toBe(before);
  });

  it('refuses a read-only key with one message and writes nothing', async () => {
    const before = await messageCount(mainConversationId);
    const refused = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations/' + mainConversationId + '/messages',
      { content: 'Reader attempt ' + runId },
      readerKey.key,
    );
    expect(refused.status).toBe(403);
    expect((refused.body as { message: string }).message).toBe(
      'The API key does not grant the required scope.',
    );
    expect(await messageCount(mainConversationId)).toBe(before);
  });

  it('tenant-bounds the write with uniform 404s per guard and no stored rows', async () => {
    const beforeMain = await messageCount(mainConversationId);
    const beforeForeign = await messageCount(foreignConversationId);
    const beforeCross = await messageCount(crossConversationId);
    const applicationMessages = new Set<string>();
    const conversationMessages = new Set<string>();

    const foreignApplication = await api(
      'POST',
      '/genapi/applications/' + foreignApplicationId + '/conversations/' + foreignConversationId + '/messages',
      { content: 'Foreign application attempt ' + runId },
      writerKey.key,
    );
    expect(foreignApplication.status).toBe(404);
    applicationMessages.add(
      (foreignApplication.body as { message: string }).message,
    );

    const unknownApplication = await api(
      'POST',
      '/genapi/applications/does-not-exist-at-all/conversations/' + mainConversationId + '/messages',
      { content: 'Unknown application attempt ' + runId },
      writerKey.key,
    );
    expect(unknownApplication.status).toBe(404);
    applicationMessages.add(
      (unknownApplication.body as { message: string }).message,
    );

    const foreignConversation = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations/' + foreignConversationId + '/messages',
      { content: 'Foreign conversation attempt ' + runId },
      irisWriter.key,
    );
    expect(foreignConversation.status).toBe(404);
    conversationMessages.add(
      (foreignConversation.body as { message: string }).message,
    );

    const unknownConversation = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations/does-not-exist-at-all/messages',
      { content: 'Unknown conversation attempt ' + runId },
      writerKey.key,
    );
    expect(unknownConversation.status).toBe(404);
    conversationMessages.add(
      (unknownConversation.body as { message: string }).message,
    );

    const crossApplication = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations/' + crossConversationId + '/messages',
      { content: 'Cross application attempt ' + runId },
      writerKey.key,
    );
    expect(crossApplication.status).toBe(404);
    conversationMessages.add(
      (crossApplication.body as { message: string }).message,
    );

    expect(applicationMessages.size).toBe(1);
    expect(Array.from(applicationMessages)[0]).toBe('Application not found.');
    expect(conversationMessages.size).toBe(1);
    expect(Array.from(conversationMessages)[0]).toBe('Conversation not found.');
    expect(await messageCount(mainConversationId)).toBe(beforeMain);
    expect(await messageCount(foreignConversationId)).toBe(beforeForeign);
    expect(await messageCount(crossConversationId)).toBe(beforeCross);
  });

  it('refuses writes to an archived conversation exactly like the JWT law', async () => {
    const archive = await api(
      'PATCH',
      '/conversations/' + archivedConversationId + '/archive',
      {},
      hank.tokens.accessToken,
    );
    expect([200, 201]).toContain(archive.status);

    const before = await messageCount(archivedConversationId);
    const refused = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations/' + archivedConversationId + '/messages',
      { content: 'Archived conversation attempt ' + runId },
      writerKey.key,
    );
    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toBe(
      'This conversation is archived or unavailable.',
    );
    expect(await messageCount(archivedConversationId)).toBe(before);
  });

  it('answers a message double-tap with two clean distinct messages', async () => {
    const before = await messageCount(mainConversationId);
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/applications/' + applicationAId + '/conversations/' + mainConversationId + '/messages',
        { content: 'Double tap message ' + runId },
        writerKey.key,
      ),
      api(
        'POST',
        '/genapi/applications/' + applicationAId + '/conversations/' + mainConversationId + '/messages',
        { content: 'Double tap message ' + runId },
        writerKey.key,
      ),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 201]);
    const firstId = (raced[0].body as { id: string }).id;
    const secondId = (raced[1].body as { id: string }).id;
    expect(firstId).not.toBe(secondId);
    expect(await messageCount(mainConversationId)).toBe(before + 2);
  });

  it('stays clean when a keyed message races a JWT conversation archive', async () => {
    const before = await messageCount(raceConversationId);
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/applications/' + applicationAId + '/conversations/' + raceConversationId + '/messages',
        { content: 'Archive race message ' + runId },
        writerKey.key,
      ),
      api(
        'PATCH',
        '/conversations/' + raceConversationId + '/archive',
        {},
        hank.tokens.accessToken,
      ),
    ]);
    expect([200, 201]).toContain(raced[1].status);
    expect([201, 409]).toContain(raced[0].status);

    const conversation = await prisma.conversation.findUnique({
      where: { id: raceConversationId },
      select: { archivedAt: true },
    });
    expect(conversation?.archivedAt).not.toBeNull();
    expect(await messageCount(raceConversationId)).toBe(
      before + (raced[0].status === 201 ? 1 : 0),
    );
  });

  it('stays clean when a keyed message races a JWT application archive', async () => {
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/applications/' + applicationCId + '/conversations/' + appCConversationId + '/messages',
        { content: 'Application archive race message ' + runId },
        writerKey.key,
      ),
      api(
        'POST',
        '/applications/' + applicationCId + '/archive',
        {},
        hank.tokens.accessToken,
      ),
    ]);
    expect(raced[1].status).toBe(201);
    expect([201, 404]).toContain(raced[0].status);

    const application = await prisma.application.findUnique({
      where: { id: applicationCId },
      select: { status: true },
    });
    expect(application?.status).toBe('ARCHIVED');

    if (raced[0].status === 201) {
      const createdId = (raced[0].body as { id: string }).id;
      const stored = await prisma.message.findUnique({
        where: { id: createdId },
        select: { id: true },
      });
      expect(stored?.id).toBe(createdId);
    }
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect([200, 201]).toContain(revoke.status);

    const revokedPost = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations/' + mainConversationId + '/messages',
      { content: 'Revoked attempt ' + runId },
      revokedKey.key,
    );
    expect(revokedPost.status).toBe(401);
    expect((revokedPost.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredPost = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations/' + mainConversationId + '/messages',
      { content: 'Expired attempt ' + runId },
      shortLivedKey.key,
    );
    expect(expiredPost.status).toBe(401);
    expect((expiredPost.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    const unauthenticated = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations/' + mainConversationId + '/messages',
      { content: 'No auth attempt ' + runId },
    );
    expect(unauthenticated.status).toBe(401);
    expect((unauthenticated.body as { message: string }).message).toBe(
      'A valid GENESIS API key is required.',
    );
  });
});
