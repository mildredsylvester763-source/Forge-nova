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
 * Key-authenticated reference deletes against the real app and the
 * real CI PostgreSQL. Grounded in the market leaders: a GitHub
 * fine-grained token needs Contents write to delete a file, and the
 * OpenAI file delete runs straight from a Bearer API key and answers
 * with the honest id plus deleted shape. The keyed delete mirrors
 * the JWT delete exactly - same guarded delete core, same honest
 * audit row per landed delete, same response shape - and the
 * writable application bound plus the reference ownership check
 * answer foreign, cross-application, and unknown ids with uniform
 * 404s that never leak what exists in other tenants.
 */
suite('GENESIS genapi reference delete flows (real app, real database)', () => {
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
    const email = 'genesis-refdel-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'reference-delete-password-123',
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

  const createKeyedReference = async (applicationId: string, title: string) =>
    api(
      'POST',
      '/genapi/applications/' + applicationId + '/references',
      { title, kind: 'NOTES', content: 'Reference delete probe content for ' + title },
      writerKey.key,
    );

  const keyedDelete = async (applicationId: string, referenceId: string, key?: string) =>
    api(
      'POST',
      '/genapi/applications/' + applicationId + '/references/' + referenceId + '/delete',
      {},
      key,
    );

  const jwtDelete = async (applicationId: string, referenceId: string, token: string) =>
    api(
      'DELETE',
      '/applications/' + applicationId + '/references/' + referenceId,
      undefined,
      token,
    );

  const referenceExists = async (referenceId: string) =>
    (await prisma.referenceDocument.count({ where: { id: referenceId } })) === 1;

  const deleteAuditCount = async (referenceId: string) =>
    prisma.auditEvent.count({
      where: {
        organizationId,
        action: 'application.reference.delete',
        resourceId: referenceId,
      },
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

    mainProjectId = await createProject(hank.tokens.accessToken, workspaceAId, 'Delete Project ' + runId);
    const foreignProjectId = await createProject(iris.tokens.accessToken, foreignWorkspaceId, 'Foreign Delete Project ' + runId);

    applicationAId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Delete App A ' + runId);
    applicationBId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Delete App B ' + runId);
    foreignApplicationId = await createApplication(iris.tokens.accessToken, foreignProjectId, 'Foreign Delete App ' + runId);

    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'Refdel Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
    readerKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Refdel Reader',
      ['READ_APPLICATIONS'],
    );
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Refdel Short Lived',
      ['WRITE_APPLICATIONS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Refdel Revoked',
      ['WRITE_APPLICATIONS'],
    );
    irisWriter = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Foreign Refdel Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
  });

  it('deletes a keyed reference and mirrors the JWT response shape exactly', async () => {
    const keyedCreate = await createKeyedReference(applicationAId, 'Keyed delete probe ' + runId);
    expect(keyedCreate.status).toBe(201);
    const keyedReferenceId = (keyedCreate.body as { id: string }).id;

    const jwtCreate = await api('POST', '/applications/' + applicationAId + '/references', { title: 'JWT delete probe ' + runId, kind: 'NOTES', content: 'JWT delete probe content' }, hank.tokens.accessToken);
    expect(jwtCreate.status).toBe(201);
    const jwtReferenceId = (jwtCreate.body as { id: string }).id;

    const keyed = await keyedDelete(applicationAId, keyedReferenceId, writerKey.key);
    expect(keyed.status).toBe(201);
    expect(Object.keys(keyed.body).sort()).toEqual(['deleted', 'id']);
    expect((keyed.body as { deleted: boolean }).deleted).toBe(true);
    expect((keyed.body as { id: string }).id).toBe(keyedReferenceId);

    const jwt = await jwtDelete(applicationAId, jwtReferenceId, hank.tokens.accessToken);
    expect(jwt.status).toBe(200);
    expect(Object.keys(jwt.body).sort()).toEqual(['deleted', 'id']);
    expect((jwt.body as { deleted: boolean }).deleted).toBe(true);
    expect((jwt.body as { id: string }).id).toBe(jwtReferenceId);

    expect(await referenceExists(keyedReferenceId)).toBe(false);
    expect(await referenceExists(jwtReferenceId)).toBe(false);
  });

  it('hides the deleted reference from both surfaces honestly', async () => {
    const created = await createKeyedReference(applicationAId, 'Visibility probe ' + runId);
    expect(created.status).toBe(201);
    const referenceId = (created.body as { id: string }).id;

    const deleted = await keyedDelete(applicationAId, referenceId, writerKey.key);
    expect(deleted.status).toBe(201);

    const keyedListing = await api('GET', '/genapi/applications/' + applicationAId + '/references', undefined, writerKey.key);
    expect(keyedListing.status).toBe(200);
    expect(
      (keyedListing.body as unknown as Array<{ id: string }>).some((row) => row.id === referenceId),
    ).toBe(false);

    const jwtInspect = await api('GET', '/applications/' + applicationAId + '/references/' + referenceId, undefined, hank.tokens.accessToken);
    expect(jwtInspect.status).toBe(404);
    expect((jwtInspect.body as { message: string }).message).toBe('Reference not found.');

    const keyedInspect = await api('GET', '/genapi/applications/' + applicationAId + '/references/' + referenceId, undefined, writerKey.key);
    expect(keyedInspect.status).toBe(404);
    expect((keyedInspect.body as { message: string }).message).toBe('Reference not found.');
  });

  it('lands exactly one attributed audit row per keyed delete', async () => {
    const created = await createKeyedReference(applicationAId, 'Audit probe ' + runId);
    expect(created.status).toBe(201);
    const referenceId = (created.body as { id: string }).id;

    const deleted = await keyedDelete(applicationAId, referenceId, writerKey.key);
    expect(deleted.status).toBe(201);

    expect(await deleteAuditCount(referenceId)).toBe(1);
    const row = await prisma.auditEvent.findFirst({
      where: {
        organizationId,
        action: 'application.reference.delete',
        resourceId: referenceId,
      },
    });
    expect(row).not.toBeNull();
    expect(row?.actorUserId).toBe(hank.userId);
    const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.via).toBe('genapi');
    expect(metadata.apiKeyId).toBe(writerKey.id);
    expect(metadata.apiKeyName).toBe('Refdel Writer');
    expect(metadata.applicationId).toBe(applicationAId);
    expect(metadata.previousStatus).toBe('STORED');
  });

  it('writes zero audit rows for refusals', async () => {
    const created = await createKeyedReference(applicationAId, 'Refusal probe ' + runId);
    expect(created.status).toBe(201);
    const referenceId = (created.body as { id: string }).id;

    const before = await prisma.auditEvent.count({ where: { organizationId } });

    const refusedScope = await keyedDelete(applicationAId, referenceId, readerKey.key);
    expect(refusedScope.status).toBe(403);
    expect((refusedScope.body as { message: string }).message).toBe('The API key does not grant the required scope.');

    const refusedUnknown = await keyedDelete(applicationAId, 'does-not-exist-at-all', writerKey.key);
    expect(refusedUnknown.status).toBe(404);
    expect((refusedUnknown.body as { message: string }).message).toBe('Reference not found.');

    const refusedCross = await keyedDelete(applicationBId, referenceId, writerKey.key);
    expect(refusedCross.status).toBe(404);
    expect((refusedCross.body as { message: string }).message).toBe('Reference not found.');

    const after = await prisma.auditEvent.count({ where: { organizationId } });
    expect(after).toBe(before);
    expect(await referenceExists(referenceId)).toBe(true);
  });

  it('tenant-bounds the delete with two uniform 404s', async () => {
    const ownCreate = await createKeyedReference(applicationAId, 'Tenant bound probe ' + runId);
    expect(ownCreate.status).toBe(201);
    const ownReferenceId = (ownCreate.body as { id: string }).id;

    const foreignCreate = await api('POST', '/genapi/applications/' + foreignApplicationId + '/references', { title: 'Foreign delete probe ' + runId, kind: 'NOTES', content: 'Foreign delete probe content' }, irisWriter.key);
    expect(foreignCreate.status).toBe(201);
    const foreignReferenceId = (foreignCreate.body as { id: string }).id;

    const applicationMessages = new Set<string>();
    const referenceMessages = new Set<string>();

    const unknownApplication = await keyedDelete('does-not-exist-at-all', ownReferenceId, writerKey.key);
    expect(unknownApplication.status).toBe(404);
    applicationMessages.add((unknownApplication.body as { message: string }).message);

    const foreignApplication = await keyedDelete(foreignApplicationId, foreignReferenceId, writerKey.key);
    expect(foreignApplication.status).toBe(404);
    applicationMessages.add((foreignApplication.body as { message: string }).message);

    const foreignKey = await keyedDelete(applicationAId, ownReferenceId, irisWriter.key);
    expect(foreignKey.status).toBe(404);
    applicationMessages.add((foreignKey.body as { message: string }).message);

    const unknownReference = await keyedDelete(applicationAId, 'does-not-exist-at-all', writerKey.key);
    expect(unknownReference.status).toBe(404);
    referenceMessages.add((unknownReference.body as { message: string }).message);

    const crossApplication = await keyedDelete(applicationBId, ownReferenceId, writerKey.key);
    expect(crossApplication.status).toBe(404);
    referenceMessages.add((crossApplication.body as { message: string }).message);

    expect(applicationMessages.size).toBe(1);
    expect(Array.from(applicationMessages)[0]).toBe('Application not found.');
    expect(referenceMessages.size).toBe(1);
    expect(Array.from(referenceMessages)[0]).toBe('Reference not found.');
    expect(await referenceExists(ownReferenceId)).toBe(true);
    expect(await referenceExists(foreignReferenceId)).toBe(true);
  });

  it('answers a double-tap with exactly one landed delete and one clean 404', async () => {
    const created = await createKeyedReference(applicationAId, 'Double tap probe ' + runId);
    expect(created.status).toBe(201);
    const referenceId = (created.body as { id: string }).id;

    const raced = await Promise.all([
      keyedDelete(applicationAId, referenceId, writerKey.key),
      keyedDelete(applicationAId, referenceId, writerKey.key),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 404]);
    const refused = raced.find((response) => response.status === 404);
    expect((refused?.body as { message: string }).message).toBe('Reference not found.');
    expect(await referenceExists(referenceId)).toBe(false);
    expect(await deleteAuditCount(referenceId)).toBe(1);
  });

  it('races a keyed delete against a JWT delete into one clean end state', async () => {
    const created = await createKeyedReference(applicationAId, 'Two actor probe ' + runId);
    expect(created.status).toBe(201);
    const referenceId = (created.body as { id: string }).id;

    const raced = await Promise.all([
      keyedDelete(applicationAId, referenceId, writerKey.key),
      jwtDelete(applicationAId, referenceId, hank.tokens.accessToken),
    ]);
    // Exactly one delete can land: whichever call commits first removes
    // the row, and the loser answers the same clean 404 it would give
    // for an unknown reference, on either surface.
    const statuses = raced.map((response) => response.status).sort();
    expect([200, 201]).toContain(statuses[0]);
    expect(statuses[1]).toBe(404);
    const refused = raced.find((response) => response.status === 404);
    expect((refused?.body as { message: string }).message).toBe('Reference not found.');
    expect(await referenceExists(referenceId)).toBe(false);
    // Exactly one landed delete writes exactly one audit row, and the
    // winner may be either surface: the JWT row keeps the legacy shape
    // with no organization stamp, so the count spans both shapes.
    const totalDeleteAudits = await prisma.auditEvent.count({
      where: { action: 'application.reference.delete', resourceId: referenceId },
    });
    expect(totalDeleteAudits).toBe(1);
  });

  it('refuses a read-only key with one message and no deleted row', async () => {
    const created = await createKeyedReference(applicationAId, 'Reader probe ' + runId);
    expect(created.status).toBe(201);
    const referenceId = (created.body as { id: string }).id;

    const refused = await keyedDelete(applicationAId, referenceId, readerKey.key);
    expect(refused.status).toBe(403);
    expect((refused.body as { message: string }).message).toBe('The API key does not grant the required scope.');
    expect(await referenceExists(referenceId)).toBe(true);
  });

  it('refuses deletes on archived applications with the same uniform 404', async () => {
    const created = await createKeyedReference(applicationBId, 'Archived application probe ' + runId);
    expect(created.status).toBe(201);
    const referenceId = (created.body as { id: string }).id;

    const archiveApplication = await api('POST', '/projects/' + mainProjectId + '/applications/' + applicationBId + '/archive', {}, hank.tokens.accessToken);
    expect(archiveApplication.status).toBe(201);

    const refused = await keyedDelete(applicationBId, referenceId, writerKey.key);
    expect(refused.status).toBe(404);
    expect((refused.body as { message: string }).message).toBe('Application not found.');
    expect(await referenceExists(referenceId)).toBe(true);
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const created = await createKeyedReference(applicationAId, 'Lifecycle probe ' + runId);
    expect(created.status).toBe(201);
    const referenceId = (created.body as { id: string }).id;

    const revoke = await api('POST', '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke', {}, hank.tokens.accessToken);
    expect([200, 201]).toContain(revoke.status);

    const revokedPost = await keyedDelete(applicationAId, referenceId, revokedKey.key);
    expect(revokedPost.status).toBe(401);
    expect((revokedPost.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredPost = await keyedDelete(applicationAId, referenceId, shortLivedKey.key);
    expect(expiredPost.status).toBe(401);
    expect((expiredPost.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const unauthenticated = await keyedDelete(applicationAId, referenceId);
    expect(unauthenticated.status).toBe(401);
    expect((unauthenticated.body as { message: string }).message).toBe('A valid GENESIS API key is required.');
    expect(await referenceExists(referenceId)).toBe(true);
  });
});
