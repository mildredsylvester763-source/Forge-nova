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

const REFERENCE_SHAPE = [
  'applicationId',
  'createdAt',
  'createdBy',
  'extractedAt',
  'extraction',
  'extractionError',
  'id',
  'kind',
  'status',
  'title',
  'updatedAt',
];

/**
 * Key-authenticated reference creates against the real app and the
 * real CI PostgreSQL. Grounded in the market leaders: a GitHub
 * fine-grained token with Contents write creates a file inside the
 * parent repository, and the OpenAI file create uploads a document
 * straight from a Bearer API key with an explicit purpose. The keyed
 * create mirrors the JWT create exactly - same trim law, same
 * response shape, same STORED status - and the writable application
 * bound refuses foreign, missing, and archived applications with one
 * uniform 404 that never leaks what exists in other tenants. Invalid
 * input answers named 400s, never a raw engine error, and the audit
 * trail records exactly one attributed row per create.
 */
suite('GENESIS genapi reference create flows (real app, real database)', () => {
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
    const email = 'genesis-refnew-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'reference-create-password-123',
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

  const referenceCount = (applicationId: string) =>
    prisma.referenceDocument.count({ where: { applicationId } });

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

    mainProjectId = await createProject(hank.tokens.accessToken, workspaceAId, 'Reference Project ' + runId);
    const foreignProjectId = await createProject(iris.tokens.accessToken, foreignWorkspaceId, 'Foreign Reference Project ' + runId);

    applicationAId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Reference App A ' + runId);
    applicationBId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Reference App B ' + runId);
    applicationCId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Reference App C ' + runId);
    foreignApplicationId = await createApplication(iris.tokens.accessToken, foreignProjectId, 'Foreign Reference App ' + runId);

    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'Reference Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
    readerKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Reference Reader',
      ['READ_APPLICATIONS'],
    );
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Reference Short Lived',
      ['WRITE_APPLICATIONS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Reference Revoked',
      ['WRITE_APPLICATIONS'],
    );
    irisWriter = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Foreign Reference Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
  });

  it('creates a keyed reference that mirrors the JWT response shape exactly', async () => {
    const before = await referenceCount(applicationAId);
    const keyed = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references',
      { title: '  Padded Spec  ', kind: 'SPEC', content: 'Keyed spec content ' + runId },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    expect((keyed.body as { title: string }).title).toBe('Padded Spec');
    expect((keyed.body as { kind: string }).kind).toBe('SPEC');
    expect((keyed.body as { status: string }).status).toBe('STORED');
    expect((keyed.body as { applicationId: string }).applicationId).toBe(applicationAId);
    expect((keyed.body as { createdBy: string | null }).createdBy).toBe(hank.userId);
    expect((keyed.body as { extraction: unknown }).extraction).toBeNull();
    expect((keyed.body as { extractionError: string | null }).extractionError).toBeNull();
    expect((keyed.body as { extractedAt: string | null }).extractedAt).toBeNull();
    expect(typeof (keyed.body as { createdAt: string }).createdAt).toBe('string');
    expect(Object.keys(keyed.body).sort()).toEqual(REFERENCE_SHAPE);

    const jwt = await api(
      'POST',
      '/applications/' + applicationAId + '/references',
      { title: 'JWT Parity Spec ' + runId, kind: 'NOTES', content: 'Parity content ' + runId },
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(201);
    expect((jwt.body as { status: string }).status).toBe('STORED');
    expect(Object.keys(jwt.body).sort()).toEqual(REFERENCE_SHAPE);
    expect(await referenceCount(applicationAId)).toBe(before + 2);
  });

  it('refuses invalid reference input with named 400s and zero rows', async () => {
    const before = await referenceCount(applicationAId);

    const badKind = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references',
      { title: 'Bad kind probe', kind: 'IMAGE', content: 'Content ' + runId },
      writerKey.key,
    );
    expect(badKind.status).toBe(400);

    const longTitle = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references',
      { title: 'x'.repeat(201), kind: 'SPEC', content: 'Content ' + runId },
      writerKey.key,
    );
    expect(longTitle.status).toBe(400);

    const longContent = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references',
      { title: 'Valid title probe', kind: 'SPEC', content: 'x'.repeat(50_001) },
      writerKey.key,
    );
    expect(longContent.status).toBe(400);

    const extraField = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references',
      { title: 'Valid title probe', kind: 'SPEC', content: 'Content ' + runId, notAField: 'nope' },
      writerKey.key,
    );
    expect(extraField.status).toBe(400);

    // Whitespace-only input used to surface as a raw engine error; the
    // wrapped engine call must answer a named 400 instead, on both
    // surfaces, because no request can ever answer a 500.
    const blankTitle = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references',
      { title: '   ', kind: 'SPEC', content: 'Content ' + runId },
      writerKey.key,
    );
    expect(blankTitle.status).toBe(400);
    expect((blankTitle.body as { message: string }).message).toContain('reference-title-required');

    const blankContent = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references',
      { title: 'Valid title probe', kind: 'SPEC', content: '   ' },
      writerKey.key,
    );
    expect(blankContent.status).toBe(400);
    expect((blankContent.body as { message: string }).message).toContain('reference-content-required');

    const secret = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references',
      { title: 'Leaked key probe', kind: 'NOTES', content: 'AKIA1234567890ABCDEF' },
      writerKey.key,
    );
    expect(secret.status).toBe(400);
    expect((secret.body as { message: string }).message).toContain('Possible secret material detected');

    expect(await referenceCount(applicationAId)).toBe(before);
  });

  it('refuses a read-only key with one message and writes nothing', async () => {
    const before = await referenceCount(applicationAId);
    const refused = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references',
      { title: 'Reader attempt ' + runId, kind: 'SPEC', content: 'Reader content ' + runId },
      readerKey.key,
    );
    expect(refused.status).toBe(403);
    expect((refused.body as { message: string }).message).toBe(
      'The API key does not grant the required scope.',
    );
    expect(await referenceCount(applicationAId)).toBe(before);
  });

  it('tenant-bounds the create with one uniform application 404 and no rows', async () => {
    const beforeOwn = await referenceCount(applicationAId);
    const beforeForeign = await referenceCount(foreignApplicationId);
    const applicationMessages = new Set<string>();

    const foreignApplication = await api(
      'POST',
      '/genapi/applications/' + foreignApplicationId + '/references',
      { title: 'Foreign application attempt ' + runId, kind: 'SPEC', content: 'Content ' + runId },
      writerKey.key,
    );
    expect(foreignApplication.status).toBe(404);
    applicationMessages.add(
      (foreignApplication.body as { message: string }).message,
    );

    const unknownApplication = await api(
      'POST',
      '/genapi/applications/does-not-exist-at-all/references',
      { title: 'Unknown application attempt ' + runId, kind: 'SPEC', content: 'Content ' + runId },
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
      '/genapi/applications/' + applicationAId + '/references',
      { title: 'Foreign key attempt ' + runId, kind: 'SPEC', content: 'Content ' + runId },
      irisWriter.key,
    );
    expect(foreignKey.status).toBe(404);
    applicationMessages.add(
      (foreignKey.body as { message: string }).message,
    );

    expect(applicationMessages.size).toBe(1);
    expect(Array.from(applicationMessages)[0]).toBe('Application not found.');
    expect(await referenceCount(applicationAId)).toBe(beforeOwn);
    expect(await referenceCount(foreignApplicationId)).toBe(beforeForeign);
  });

  it('refuses creates on archived applications with the same uniform 404', async () => {
    const archive = await api(
      'POST',
      '/projects/' + mainProjectId + '/applications/' + applicationBId + '/archive',
      {},
      hank.tokens.accessToken,
    );
    expect(archive.status).toBe(201);

    const before = await referenceCount(applicationBId);
    const refused = await api(
      'POST',
      '/genapi/applications/' + applicationBId + '/references',
      { title: 'Archived application attempt ' + runId, kind: 'SPEC', content: 'Content ' + runId },
      writerKey.key,
    );
    expect(refused.status).toBe(404);
    expect((refused.body as { message: string }).message).toBe('Application not found.');
    expect(await referenceCount(applicationBId)).toBe(before);
  });

  it('writes exactly one attributed audit row per keyed create and none for refusals', async () => {
    const auditWhere = {
      action: 'application.reference.create',
      organizationId,
    };
    const before = await prisma.auditEvent.count({ where: auditWhere });

    const keyed = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references',
      { title: 'Audit Probe ' + runId, kind: 'OTHER', content: 'Audit content ' + runId },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    const createdId = (keyed.body as { id: string }).id;

    expect(await prisma.auditEvent.count({ where: auditWhere })).toBe(before + 1);
    const row = await prisma.auditEvent.findFirst({
      where: auditWhere,
      orderBy: { createdAt: 'desc' },
      select: { resourceId: true, metadata: true },
    });
    expect(row?.resourceId).toBe(createdId);
    const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.via).toBe('genapi');
    expect(metadata.apiKeyId).toBe(writerKey.id);
    expect(metadata.apiKeyName).toBe('Reference Writer');
    expect(metadata.applicationId).toBe(applicationAId);

    // Reads and refusals never write audit rows; only the state change
    // lands in the trail, exactly once, attributed to the acting key.
    const refused = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references',
      { title: '   ', kind: 'SPEC', content: 'Refusal content ' + runId },
      writerKey.key,
    );
    expect(refused.status).toBe(400);
    expect(await prisma.auditEvent.count({ where: auditWhere })).toBe(before + 1);
  });

  it('keeps the keyed reference visible on both surfaces with full content', async () => {
    const keyed = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references',
      { title: 'Visibility Probe ' + runId, kind: 'SPEC', content: 'Visibility content ' + runId },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    const createdId = (keyed.body as { id: string }).id;

    const keyedListing = await api(
      'GET',
      '/genapi/applications/' + applicationAId + '/references',
      undefined,
      writerKey.key,
    );
    expect(keyedListing.status).toBe(200);
    const keyedRows = keyedListing.body as unknown as Array<{
      id: string;
      title: string;
      content: string;
    }>;
    const ownRow = keyedRows.find((row) => row.id === createdId);
    expect(ownRow?.title).toBe('Visibility Probe ' + runId);
    expect(ownRow?.content).toBe('Visibility content ' + runId);

    const jwtListing = await api(
      'GET',
      '/applications/' + applicationAId + '/references',
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

  it('answers a double-tap with two honest independent references', async () => {
    const before = await referenceCount(applicationAId);
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/applications/' + applicationAId + '/references',
        { title: 'Double tap reference ' + runId, kind: 'SPEC', content: 'Double tap content ' + runId },
        writerKey.key,
      ),
      api(
        'POST',
        '/genapi/applications/' + applicationAId + '/references',
        { title: 'Double tap reference ' + runId, kind: 'SPEC', content: 'Double tap content ' + runId },
        writerKey.key,
      ),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 201]);
    const firstId = (raced[0].body as { id: string }).id;
    const secondId = (raced[1].body as { id: string }).id;
    expect(firstId).not.toBe(secondId);
    expect(await referenceCount(applicationAId)).toBe(before + 2);
  });

  it('stays clean when a keyed create races a JWT application archive', async () => {
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/applications/' + applicationCId + '/references',
        { title: 'Application archive race reference ' + runId, kind: 'SPEC', content: 'Race content ' + runId },
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
      const stored = await prisma.referenceDocument.findUnique({
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
      '/genapi/applications/' + applicationAId + '/references',
      { title: 'Revoked attempt ' + runId, kind: 'SPEC', content: 'Revoked content ' + runId },
      revokedKey.key,
    );
    expect(revokedPost.status).toBe(401);
    expect((revokedPost.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredPost = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references',
      { title: 'Expired attempt ' + runId, kind: 'SPEC', content: 'Expired content ' + runId },
      shortLivedKey.key,
    );
    expect(expiredPost.status).toBe(401);
    expect((expiredPost.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    const unauthenticated = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references',
      { title: 'No auth attempt ' + runId, kind: 'SPEC', content: 'No auth content ' + runId },
    );
    expect(unauthenticated.status).toBe(401);
    expect((unauthenticated.body as { message: string }).message).toBe(
      'A valid GENESIS API key is required.',
    );
  });
});
