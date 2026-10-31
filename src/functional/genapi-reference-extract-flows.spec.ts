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

const HONEST_EXTRACT_STATUSES = [200, 502, 503];

/**
 * Key-authenticated reference extraction against the real app and the
 * real CI PostgreSQL. Grounded in the OpenAI vector store file
 * processing: attaching an uploaded file to a vector store triggers
 * AI processing straight from an API key, and the file carries its
 * honest processing status with a recorded last_error. The keyed
 * extract mirrors the JWT extract exactly through one shared core -
 * the same reference bound, the same honest failure recording, the
 * same audit law - and the writable application bound refuses
 * foreign, missing, and archived applications with one uniform 404
 * that never leaks what exists in other tenants. A processing failure
 * marks the reference EXTRACTION_FAILED with the recorded error and
 * never answers a 500; refusals never touch the reference and never
 * write audit rows.
 */
suite('GENESIS genapi reference extract flows (real app, real database)', () => {
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
  let extractProbeId: string;
  let jwtProbeId: string;
  let scopeProbeId: string;
  let retryProbeId: string;
  let raceDeleteId: string;
  let applicationBReferenceId: string;
  let applicationCReferenceId: string;
  let foreignReferenceId: string;
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
    const email = 'genesis-refex-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'reference-extract-password-123',
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

  const createReference = async (
    token: string,
    applicationId: string,
    title: string,
    keyed: boolean,
  ) => {
    const path = keyed
      ? '/genapi/applications/' + applicationId + '/references'
      : '/applications/' + applicationId + '/references';
    const response = await api(
      'POST',
      path,
      { title, kind: 'SPEC', content: title + ' body ' + runId },
      token,
    );
    expect(response.status).toBe(201);
    expect((response.body as { status: string }).status).toBe('STORED');
    return (response.body as { id: string }).id;
  };

  const extractAuditCount = () =>
    prisma.auditEvent.count({
      where: { action: 'application.reference.extract', organizationId },
    });

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

  it('seeds two organizations, applications, references, and scoped keys', async () => {
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

    mainProjectId = await createProject(hank.tokens.accessToken, workspaceAId, 'Extract Project ' + runId);
    const foreignProjectId = await createProject(iris.tokens.accessToken, foreignWorkspaceId, 'Foreign Extract Project ' + runId);

    applicationAId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Extract App A ' + runId);
    applicationBId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Extract App B ' + runId);
    applicationCId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Extract App C ' + runId);
    foreignApplicationId = await createApplication(iris.tokens.accessToken, foreignProjectId, 'Foreign Extract App ' + runId);

    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'Extract Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
    readerKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Extract Reader',
      ['READ_APPLICATIONS'],
    );
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Extract Short Lived',
      ['WRITE_APPLICATIONS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Extract Revoked',
      ['WRITE_APPLICATIONS'],
    );
    irisWriter = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Foreign Extract Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);

    extractProbeId = await createReference(writerKey.key, applicationAId, 'Extraction probe', true);
    jwtProbeId = await createReference(hank.tokens.accessToken, applicationAId, 'JWT parity probe', false);
    scopeProbeId = await createReference(writerKey.key, applicationAId, 'Scope refusal probe', true);
    retryProbeId = await createReference(writerKey.key, applicationAId, 'Retry probe', true);
    raceDeleteId = await createReference(writerKey.key, applicationAId, 'Delete race probe', true);
    applicationBReferenceId = await createReference(writerKey.key, applicationBId, 'Archive refusal probe', true);
    applicationCReferenceId = await createReference(writerKey.key, applicationCId, 'Archive race probe', true);
    foreignReferenceId = await createReference(irisWriter.key, foreignApplicationId, 'Foreign probe', true);
  });

  it('answers the honest keyed processing law and records the failure on the reference', async () => {
    const auditBefore = await extractAuditCount();
    const keyed = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references/' + extractProbeId + '/extract',
      {},
      writerKey.key,
    );
    expect(HONEST_EXTRACT_STATUSES).toContain(keyed.status);

    if (keyed.status === 200) {
      expect((keyed.body as { status: string }).status).toBe('EXTRACTED');
    } else {
      const inspected = await api(
        'GET',
        '/genapi/applications/' + applicationAId + '/references/' + extractProbeId,
        undefined,
        writerKey.key,
      );
      expect(inspected.status).toBe(200);
      expect((inspected.body as { status: string }).status).toBe('EXTRACTION_FAILED');
      expect(typeof (inspected.body as { extractionError: string | null }).extractionError).toBe('string');
      expect((inspected.body as { extractedAt: string | null }).extractedAt).toBeNull();
      expect((inspected.body as { content: string }).content).toContain('Extraction probe body');
      expect(await extractAuditCount()).toBe(auditBefore);
    }
  });

  it('mirrors the JWT extract law exactly on a second reference', async () => {
    const jwt = await api(
      'POST',
      '/applications/' + applicationAId + '/references/' + jwtProbeId + '/extract',
      {},
      hank.tokens.accessToken,
    );
    expect(HONEST_EXTRACT_STATUSES).toContain(jwt.status);

    const inspected = await api(
      'GET',
      '/applications/' + applicationAId + '/references/' + jwtProbeId,
      undefined,
      hank.tokens.accessToken,
    );
    expect(inspected.status).toBe(200);
    expect((inspected.body as { status: string }).status)
      .toBe(jwt.status === 200 ? 'EXTRACTED' : 'EXTRACTION_FAILED');
    if (jwt.status !== 200) {
      expect(typeof (inspected.body as { extractionError: string | null }).extractionError).toBe('string');
    }

    const jwtAudit = await prisma.auditEvent.count({
      where: { action: 'application.reference.extract', resourceId: jwtProbeId },
    });
    expect(jwtAudit).toBe(jwt.status === 200 ? 1 : 0);
  });

  it('refuses a read-only key with one message, no state change, and no audit row', async () => {
    const auditBefore = await extractAuditCount();
    const refused = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references/' + scopeProbeId + '/extract',
      {},
      readerKey.key,
    );
    expect(refused.status).toBe(403);
    expect((refused.body as { message: string }).message).toBe(
      'The API key does not grant the required scope.',
    );
    const row = await prisma.referenceDocument.findUnique({
      where: { id: scopeProbeId },
      select: { status: true },
    });
    expect(row?.status).toBe('STORED');
    expect(await extractAuditCount()).toBe(auditBefore);
  });

  it('tenant-bounds the extract with uniform 404s per guard and no state change', async () => {
    const applicationMessages = new Set<string>();
    const referenceMessages = new Set<string>();

    const foreignApplication = await api(
      'POST',
      '/genapi/applications/' + foreignApplicationId + '/references/' + foreignReferenceId + '/extract',
      {},
      writerKey.key,
    );
    expect(foreignApplication.status).toBe(404);
    applicationMessages.add((foreignApplication.body as { message: string }).message);

    const unknownApplication = await api(
      'POST',
      '/genapi/applications/does-not-exist-at-all/references/' + extractProbeId + '/extract',
      {},
      writerKey.key,
    );
    expect(unknownApplication.status).toBe(404);
    applicationMessages.add((unknownApplication.body as { message: string }).message);

    // The key organization governs the application tenant bound, so a
    // foreign key is refused at the application guard even though the
    // application and reference are real.
    const foreignKey = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references/' + extractProbeId + '/extract',
      {},
      irisWriter.key,
    );
    expect(foreignKey.status).toBe(404);
    applicationMessages.add((foreignKey.body as { message: string }).message);

    // A reference that exists in another own application is refused at
    // the reference bound with the same uniform 404 as an unknown one.
    const crossApplication = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references/' + applicationBReferenceId + '/extract',
      {},
      writerKey.key,
    );
    expect(crossApplication.status).toBe(404);
    referenceMessages.add((crossApplication.body as { message: string }).message);

    const unknownReference = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references/does-not-exist-at-all/extract',
      {},
      writerKey.key,
    );
    expect(unknownReference.status).toBe(404);
    referenceMessages.add((unknownReference.body as { message: string }).message);

    expect(applicationMessages.size).toBe(1);
    expect(Array.from(applicationMessages)[0]).toBe('Application not found.');
    expect(referenceMessages.size).toBe(1);
    expect(Array.from(referenceMessages)[0]).toBe('Reference not found.');

    const untouched = await prisma.referenceDocument.findMany({
      where: { id: { in: [applicationBReferenceId, foreignReferenceId] } },
      select: { status: true },
    });
    expect(untouched.every((row) => row.status === 'STORED')).toBe(true);
  });

  it('refuses extracts on archived applications with the same uniform 404', async () => {
    const archive = await api(
      'POST',
      '/projects/' + mainProjectId + '/applications/' + applicationBId + '/archive',
      {},
      hank.tokens.accessToken,
    );
    expect(archive.status).toBe(201);

    const refused = await api(
      'POST',
      '/genapi/applications/' + applicationBId + '/references/' + applicationBReferenceId + '/extract',
      {},
      writerKey.key,
    );
    expect(refused.status).toBe(404);
    expect((refused.body as { message: string }).message).toBe('Application not found.');
    const row = await prisma.referenceDocument.findUnique({
      where: { id: applicationBReferenceId },
      select: { status: true },
    });
    expect(row?.status).toBe('STORED');
  });

  it('answers a double-tapped extract with two honest outcomes and one consistent state', async () => {
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/applications/' + applicationAId + '/references/' + retryProbeId + '/extract',
        {},
        writerKey.key,
      ),
      api(
        'POST',
        '/genapi/applications/' + applicationAId + '/references/' + retryProbeId + '/extract',
        {},
        writerKey.key,
      ),
    ]);
    raced.forEach((response) => expect(HONEST_EXTRACT_STATUSES).toContain(response.status));
    const row = await prisma.referenceDocument.findUnique({
      where: { id: retryProbeId },
      select: { status: true },
    });
    const anySuccess = raced.some((response) => response.status === 200);
    expect(row?.status).toBe(anySuccess ? 'EXTRACTED' : 'EXTRACTION_FAILED');
  });

  it('stays clean when a keyed extract races a JWT reference delete', async () => {
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/applications/' + applicationAId + '/references/' + raceDeleteId + '/extract',
        {},
        writerKey.key,
      ),
      api(
        'DELETE',
        '/applications/' + applicationAId + '/references/' + raceDeleteId,
        undefined,
        hank.tokens.accessToken,
      ),
    ]);
    expect(raced[1].status).toBe(200);
    expect((raced[1].body as { deleted: boolean }).deleted).toBe(true);
    expect([404, 502, 503]).toContain(raced[0].status);
    if (raced[0].status === 404) {
      expect((raced[0].body as { message: string }).message).toBe('Reference not found.');
    }
    const remaining = await prisma.referenceDocument.count({
      where: { id: raceDeleteId },
    });
    expect(remaining).toBe(0);
  });

  it('stays clean when a keyed extract races a JWT application archive', async () => {
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/applications/' + applicationCId + '/references/' + applicationCReferenceId + '/extract',
        {},
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
    expect([200, 404, 502, 503]).toContain(raced[0].status);
    if (raced[0].status === 404) {
      expect((raced[0].body as { message: string }).message).toBe('Application not found.');
    }

    const application = await prisma.application.findUnique({
      where: { id: applicationCId },
      select: { status: true },
    });
    expect(application?.status).toBe('ARCHIVED');

    const row = await prisma.referenceDocument.findUnique({
      where: { id: applicationCReferenceId },
      select: { status: true },
    });
    if (raced[0].status === 404) {
      expect(row?.status).toBe('STORED');
    } else if (raced[0].status === 200) {
      expect(row?.status).toBe('EXTRACTED');
    } else {
      expect(row?.status).toBe('EXTRACTION_FAILED');
    }
  });

  it('retries an honest failed extraction without corrupting the reference', async () => {
    const first = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references/' + retryProbeId + '/extract',
      {},
      writerKey.key,
    );
    expect(HONEST_EXTRACT_STATUSES).toContain(first.status);
    const second = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references/' + retryProbeId + '/extract',
      {},
      writerKey.key,
    );
    expect(HONEST_EXTRACT_STATUSES).toContain(second.status);

    const row = await prisma.referenceDocument.findUnique({
      where: { id: retryProbeId },
      select: { status: true, content: true, extractedAt: true },
    });
    expect(row?.content).toContain('Retry probe body');
    if (first.status !== 200 && second.status !== 200) {
      expect(row?.status).toBe('EXTRACTION_FAILED');
      expect(row?.extractedAt).toBeNull();
    } else {
      expect(row?.status).toBe('EXTRACTED');
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
      '/genapi/applications/' + applicationAId + '/references/' + extractProbeId + '/extract',
      {},
      revokedKey.key,
    );
    expect(revokedPost.status).toBe(401);
    expect((revokedPost.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredPost = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references/' + extractProbeId + '/extract',
      {},
      shortLivedKey.key,
    );
    expect(expiredPost.status).toBe(401);
    expect((expiredPost.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    const unauthenticated = await api(
      'POST',
      '/genapi/applications/' + applicationAId + '/references/' + extractProbeId + '/extract',
      {},
    );
    expect(unauthenticated.status).toBe(401);
    expect((unauthenticated.body as { message: string }).message).toBe(
      'A valid GENESIS API key is required.',
    );
  });
});
