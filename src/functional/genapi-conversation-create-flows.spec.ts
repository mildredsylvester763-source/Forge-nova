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
 * Key-authenticated conversation creates against the real app and the
 * real CI PostgreSQL. Grounded in the market leaders: a GitHub token
 * with write permission creates an issue under a specific repository
 * with only the title required, and the OpenAI thread create builds
 * an empty conversation object straight from an API key. The keyed
 * create mirrors the JWT create exactly - same optional title trim
 * law, same response shape, same honest zero-count listings - and the
 * writable application bound refuses foreign, missing, and archived
 * applications with one uniform 404 that never leaks what exists in
 * other tenants.
 */
suite('GENESIS genapi conversation create flows (real app, real database)', () => {
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
    const email = 'genesis-convnew-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'conversation-create-password-123',
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

  const conversationCount = (applicationId: string) =>
    prisma.conversation.count({ where: { applicationId } });

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

    mainProjectId = await createProject(hank.tokens.accessToken, workspaceAId, 'Conversation Project ' + runId);
    const foreignProjectId = await createProject(iris.tokens.accessToken, foreignWorkspaceId, 'Foreign Conversation Project ' + runId);

    applicationAId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Conversation App A ' + runId);
    applicationBId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Conversation App B ' + runId);
    applicationCId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Conversation App C ' + runId);
    foreignApplicationId = await createApplication(iris.tokens.accessToken, foreignProjectId, 'Foreign Conversation App ' + runId);

    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'Conversation Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
    readerKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Conversation Reader',
      ['READ_APPLICATIONS'],
    );
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Conversation Short Lived',
      ['WRITE_APPLICATIONS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Conversation Revoked',
      ['WRITE_APPLICATIONS'],
    );
    irisWriter = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Foreign Conversation Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
  });

  it('creates a keyed conversation that mirrors the JWT response shape exactly', async () => {
    const before = await conversationCount(applicationAId);
    const keyed = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations',
      { title: '  Padded Conversation  ' },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    expect((keyed.body as { title: string }).title).toBe('Padded Conversation');
    expect((keyed.body as { applicationId: string }).applicationId).toBe(applicationAId);
    expect((keyed.body as { archivedAt: string | null }).archivedAt).toBeNull();
    expect(typeof (keyed.body as { createdAt: string }).createdAt).toBe('string');
    expect(Object.keys(keyed.body).sort()).toEqual(
      ['applicationId', 'archivedAt', 'createdAt', 'id', 'title'],
    );

    const jwt = await api(
      'POST',
      '/applications/' + applicationAId + '/conversations',
      { title: 'JWT Parity Conversation ' + runId },
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(201);
    expect(Object.keys(jwt.body).sort()).toEqual(
      ['applicationId', 'archivedAt', 'createdAt', 'id', 'title'],
    );
    expect(await conversationCount(applicationAId)).toBe(before + 2);
  });

  it('creates an untitled keyed conversation exactly like the JWT law', async () => {
    const before = await conversationCount(applicationAId);
    const keyed = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations',
      {},
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    expect((keyed.body as { title: string | null }).title).toBeNull();
    expect(await conversationCount(applicationAId)).toBe(before + 1);
  });

  it('keeps the keyed conversation visible on both surfaces with an honest zero count', async () => {
    const keyed = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations',
      { title: 'Visibility Probe ' + runId },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    const createdId = (keyed.body as { id: string }).id;

    const keyedListing = await api(
      'GET',
      '/genapi/applications/' + applicationAId + '/conversations',
      undefined,
      writerKey.key,
    );
    expect(keyedListing.status).toBe(200);
    const keyedRows = keyedListing.body as unknown as Array<{
      id: string;
      _count: { messages: number };
    }>;
    const ownRow = keyedRows.find((row) => row.id === createdId);
    expect(ownRow?._count?.messages).toBe(0);

    const jwtListing = await api(
      'GET',
      '/applications/' + applicationAId + '/conversations',
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

  it('refuses a read-only key with one message and writes nothing', async () => {
    const before = await conversationCount(applicationAId);
    const refused = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations',
      { title: 'Reader attempt ' + runId },
      readerKey.key,
    );
    expect(refused.status).toBe(403);
    expect((refused.body as { message: string }).message).toBe(
      'The API key does not grant the required scope.',
    );
    expect(await conversationCount(applicationAId)).toBe(before);
  });

  it('refuses invalid titles with named 400s and zero rows', async () => {
    const before = await conversationCount(applicationAId);

    const emptyTitle = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations',
      { title: '' },
      writerKey.key,
    );
    expect(emptyTitle.status).toBe(400);

    const longTitle = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations',
      { title: 'x'.repeat(161) },
      writerKey.key,
    );
    expect(longTitle.status).toBe(400);

    const extraField = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations',
      { title: 'Valid title', notAField: 'nope' },
      writerKey.key,
    );
    expect(extraField.status).toBe(400);

    expect(await conversationCount(applicationAId)).toBe(before);
  });

  it('tenant-bounds the create with one uniform application 404 and no rows', async () => {
    const beforeOwn = await conversationCount(applicationAId);
    const beforeForeign = await conversationCount(foreignApplicationId);
    const applicationMessages = new Set<string>();

    const foreignApplication = await api(
      'POST',
      '/genapi/applications/' + foreignApplicationId + '/conversations',
      { title: 'Foreign application attempt ' + runId },
      writerKey.key,
    );
    expect(foreignApplication.status).toBe(404);
    applicationMessages.add(
      (foreignApplication.body as { message: string }).message,
    );

    const unknownApplication = await api(
      'POST',
      '/genapi/applications/does-not-exist-at-all/conversations',
      { title: 'Unknown application attempt ' + runId },
      writerKey.key,
    );
    expect(unknownApplication.status).toBe(404);
    applicationMessages.add(
      (unknownApplication.body as { message: string }).message,
    );

    // The key organization governs the application tenant bound, so a
    // foreign key is refused at the application guard even though the
    // application is real.
    const foreignKey = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations',
      { title: 'Foreign key attempt ' + runId },
      irisWriter.key,
    );
    expect(foreignKey.status).toBe(404);
    applicationMessages.add(
      (foreignKey.body as { message: string }).message,
    );

    expect(applicationMessages.size).toBe(1);
    expect(Array.from(applicationMessages)[0]).toBe('Application not found.');
    expect(await conversationCount(applicationAId)).toBe(beforeOwn);
    expect(await conversationCount(foreignApplicationId)).toBe(beforeForeign);
  });

  it('refuses creates on archived applications with the same uniform 404', async () => {
    const archive = await api(
      'POST',
      '/projects/' + mainProjectId + '/applications/' + applicationBId + '/archive',
      {},
      hank.tokens.accessToken,
    );
    expect(archive.status).toBe(201);

    const before = await conversationCount(applicationBId);
    const refused = await api(
      'POST',
      '/genapi/applications/' + applicationBId + '/conversations',
      { title: 'Archived application attempt ' + runId },
      writerKey.key,
    );
    expect(refused.status).toBe(404);
    expect((refused.body as { message: string }).message).toBe('Application not found.');
    expect(await conversationCount(applicationBId)).toBe(before);
  });

  it('answers a double-tap with two honest independent conversations', async () => {
    const before = await conversationCount(applicationAId);
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/applications/' + applicationAId + '/conversations',
        { title: 'Double tap conversation ' + runId },
        writerKey.key,
      ),
      api(
        'POST',
        '/genapi/applications/' + applicationAId + '/conversations',
        { title: 'Double tap conversation ' + runId },
        writerKey.key,
      ),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 201]);
    const firstId = (raced[0].body as { id: string }).id;
    const secondId = (raced[1].body as { id: string }).id;
    expect(firstId).not.toBe(secondId);
    expect(await conversationCount(applicationAId)).toBe(before + 2);
  });

  it('stays clean when a keyed create races a JWT application archive', async () => {
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/applications/' + applicationCId + '/conversations',
        { title: 'Application archive race conversation ' + runId },
        writerKey.key,
      ),
      api(
        'POST',
        '/projects/' + mainProjectId + '/applications/' + applicationCId + '/archive',
        {},
        hank.tokens.accessToken,
      ),
    ]);
    expect(raced[1].status).toBe(201);
    expect([201, 404]).toContain(raced[0].status);
    if (raced[0].status === 404) {
      expect((raced[0].body as { message: string }).message).toBe(
        'Application not found.',
      );
    }

    const application = await prisma.application.findUnique({
      where: { id: applicationCId },
      select: { status: true },
    });
    expect(application?.status).toBe('ARCHIVED');

    if (raced[0].status === 201) {
      const createdId = (raced[0].body as { id: string }).id;
      const stored = await prisma.conversation.findUnique({
        where: { id: createdId },
        select: { id: true, applicationId: true },
      });
      expect(stored?.applicationId).toBe(applicationCId);
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
      '/genapi/applications/' + applicationAId + '/conversations',
      { title: 'Revoked attempt ' + runId },
      revokedKey.key,
    );
    expect(revokedPost.status).toBe(401);
    expect((revokedPost.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredPost = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations',
      { title: 'Expired attempt ' + runId },
      shortLivedKey.key,
    );
    expect(expiredPost.status).toBe(401);
    expect((expiredPost.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    const unauthenticated = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/conversations',
      { title: 'No auth attempt ' + runId },
    );
    expect(unauthenticated.status).toBe(401);
    expect((unauthenticated.body as { message: string }).message).toBe(
      'A valid GENESIS API key is required.',
    );
  });
});
