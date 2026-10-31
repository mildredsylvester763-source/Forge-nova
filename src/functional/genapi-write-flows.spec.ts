import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

const hasDatabase = typeof process.env.DATABASE_URL === 'string'
  && process.env.DATABASE_URL.startsWith('postgres');
const hasJwtSecret = typeof process.env.JWT_ACCESS_SECRET === 'string'
  && process.env.JWT_ACCESS_SECRET.length >= 32;
const suite = hasDatabase && hasJwtSecret ? describe : describe.skip;

interface TokenPair { accessToken: string; refreshToken: string; }

interface UserContext { email: string; tokens: TokenPair; userId: string; }

interface ApiResponse { status: number; body: Record<string, unknown>; }

const WRITE_SCOPES = ['READ_APPLICATIONS', 'WRITE_APPLICATIONS'];

suite('genapi key-authenticated write flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let prisma: import('../database/prisma.service').PrismaService;
  let hank: UserContext;
  let iris: UserContext;
  let organizationIdA: string;
  let organizationIdB: string;
  let workspaceIdA: string;
  let projectIdA: string;
  let projectIdB: string;
  let applicationIdA: string;
  let applicationIdB: string;
  let writerKey: string;
  let writerKeyId: string;
  let writerKey2: string;
  let readerKey: string;
  let irisKey: string;
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);

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
    const email = 'genesis-write-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'genapi-write-test-password-123',
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
    organizationId: string,
    name: string,
    scopes: string[],
    expiresAt?: string,
  ) => {
    const body = expiresAt === undefined ? { name, scopes } : { name, scopes, expiresAt };
    return api('POST', '/organizations/' + organizationId + '/api-keys', body, token);
  };

  const genapi = (path: string, key: string | undefined, body: unknown = undefined) =>
    api('POST', '/genapi/' + path, body, key);

  const writeFile = (key: string | undefined, applicationId: string, path: string, content: string, expectedRevision?: number) =>
    genapi(
      'applications/' + applicationId + '/files',
      key,
      expectedRevision === undefined ? { path, content } : { path, content, expectedRevision },
    );

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

    const { PrismaService } = await import('../database/prisma.service');
    prisma = app.get(PrismaService);

    const server = app.getHttpServer() as import('node:http').Server;
    const address = server.address() as { port: number };
    baseUrl = 'http://127.0.0.1:' + address.port + '/api/v1';
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('seeds two tenants and keys with distinct scopes', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const orgsA = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(orgsA.status).toBe(200);
    organizationIdA = (orgsA.body as unknown as Array<{ id: string }>)[0].id;
    const workspacesA = await api('GET', '/workspaces', undefined, hank.tokens.accessToken);
    expect(workspacesA.status).toBe(200);
    workspaceIdA = (workspacesA.body as unknown as Array<{ id: string }>)[0].id;
    const projectA = await api(
      'POST',
      '/workspaces/' + workspaceIdA + '/projects',
      { name: 'Genapi Write Project' },
      hank.tokens.accessToken,
    );
    expect(projectA.status).toBe(201);
    projectIdA = (projectA.body as { id: string }).id;
    const applicationA = await api(
      'POST',
      '/projects/' + projectIdA + '/applications',
      { name: 'Genapi Write App' },
      hank.tokens.accessToken,
    );
    expect(applicationA.status).toBe(201);
    applicationIdA = (applicationA.body as { id: string }).id;

    const orgsB = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(orgsB.status).toBe(200);
    organizationIdB = (orgsB.body as unknown as Array<{ id: string }>)[0].id;
    const workspacesB = await api('GET', '/workspaces', undefined, iris.tokens.accessToken);
    expect(workspacesB.status).toBe(200);
    const workspaceIdB = (workspacesB.body as unknown as Array<{ id: string }>)[0].id;
    const projectB = await api(
      'POST',
      '/workspaces/' + workspaceIdB + '/projects',
      { name: 'Iris Foreign Project' },
      iris.tokens.accessToken,
    );
    expect(projectB.status).toBe(201);
    projectIdB = (projectB.body as { id: string }).id;
    const applicationB = await api(
      'POST',
      '/projects/' + projectIdB + '/applications',
      { name: 'Iris Foreign App' },
      iris.tokens.accessToken,
    );
    expect(applicationB.status).toBe(201);
    applicationIdB = (applicationB.body as { id: string }).id;

    const writer = await createKey(hank.tokens.accessToken, organizationIdA, 'writer', WRITE_SCOPES);
    expect(writer.status).toBe(201);
    writerKey = (writer.body as { key: string }).key;
    writerKeyId = (writer.body as { id: string }).id;
    expect((writer.body as { scopes: string[] }).scopes).toEqual(WRITE_SCOPES);

    const secondWriter = await createKey(
      hank.tokens.accessToken,
      organizationIdA,
      'writer-two',
      ['WRITE_APPLICATIONS'],
    );
    expect(secondWriter.status).toBe(201);
    writerKey2 = (secondWriter.body as { key: string }).key;

    const reader = await createKey(hank.tokens.accessToken, organizationIdA, 'reader', ['READ_APPLICATIONS']);
    expect(reader.status).toBe(201);
    readerKey = (reader.body as { key: string }).key;

    const foreign = await createKey(iris.tokens.accessToken, organizationIdB, 'iris-writer', ['WRITE_APPLICATIONS']);
    expect(foreign.status).toBe(201);
    irisKey = (foreign.body as { key: string }).key;
  });

  it('lets a write-scoped key create a file with honest attribution', async () => {
    const created = await writeFile(writerKey, applicationIdA, 'src/index.ts', 'export const answer = 42;');
    expect(created.status).toBe(201);
    expect((created.body as { revision: number }).revision).toBe(1);

    const row = await prisma.applicationFile.findUnique({
      where: { applicationId_path: { applicationId: applicationIdA, path: 'src/index.ts' } },
    });
    expect(row).not.toBeNull();
    expect(row?.createdBy).toBe(hank.userId);
    expect(row?.revision).toBe(1);
  });

  it('refuses a read-only key write with no side effects', async () => {
    const refused = await writeFile(readerKey, applicationIdA, 'src/reader.ts', 'export const nothing = true;');
    expect(refused.status).toBe(403);
    const count = await prisma.applicationFile.count({
      where: { applicationId: applicationIdA, path: 'src/reader.ts' },
    });
    expect(count).toBe(0);
  });

  it('enforces optimistic concurrency on keyed updates', async () => {
    const updated = await writeFile(
      writerKey,
      applicationIdA,
      'src/index.ts',
      'export const answer = 43;',
      1,
    );
    expect(updated.status).toBe(201);
    expect((updated.body as { revision: number }).revision).toBe(2);

    const noRevision = await writeFile(writerKey, applicationIdA, 'src/index.ts', 'export const answer = 44;');
    expect(noRevision.status).toBe(409);

    const staleRevision = await writeFile(writerKey, applicationIdA, 'src/index.ts', 'export const answer = 45;', 99);
    expect(staleRevision.status).toBe(409);

    const row = await prisma.applicationFile.findUnique({
      where: { applicationId_path: { applicationId: applicationIdA, path: 'src/index.ts' } },
    });
    expect(row?.revision).toBe(2);
  });

  it('resolves a double-tap update race with exactly one winner', async () => {
    const raced = await Promise.all([
      writeFile(writerKey, applicationIdA, 'src/index.ts', 'export const answer = 100;', 2),
      writeFile(writerKey, applicationIdA, 'src/index.ts', 'export const answer = 101;', 2),
    ]);
    expect(raced.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 409]);

    const row = await prisma.applicationFile.findUnique({
      where: { applicationId_path: { applicationId: applicationIdA, path: 'src/index.ts' } },
    });
    expect(row?.revision).toBe(3);
    const revisions = await prisma.fileRevision.findMany({
      where: { fileId: row?.id },
      orderBy: { revision: 'asc' },
    });
    expect(revisions.map((revision) => revision.revision)).toEqual([1, 2, 3]);
  });

  it('resolves two different keys racing the same file with exactly one winner', async () => {
    const raced = await Promise.all([
      writeFile(writerKey, applicationIdA, 'src/index.ts', 'export const answer = 200;', 3),
      writeFile(writerKey2, applicationIdA, 'src/index.ts', 'export const answer = 201;', 3),
    ]);
    expect(raced.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 409]);

    const row = await prisma.applicationFile.findUnique({
      where: { applicationId_path: { applicationId: applicationIdA, path: 'src/index.ts' } },
    });
    expect(row?.revision).toBe(4);
    const revisions = await prisma.fileRevision.findMany({
      where: { fileId: row?.id },
      orderBy: { revision: 'asc' },
    });
    expect(revisions.map((revision) => revision.revision)).toEqual([1, 2, 3, 4]);
  });

  it('refuses cross-tenant writes with a uniform 404 and leaves no trace', async () => {
    const foreignFile = await writeFile(irisKey, applicationIdA, 'src/foreign.ts', 'export const intrusion = true;');
    expect(foreignFile.status).toBe(404);
    const foreignCheckpoint = await genapi('applications/' + applicationIdA + '/checkpoints', irisKey, { label: 'foreign' });
    expect(foreignCheckpoint.status).toBe(404);
    const foreignArchive = await genapi('applications/' + applicationIdA + '/archive', irisKey, {});
    expect(foreignArchive.status).toBe(404);
    const foreignVerification = await genapi('applications/' + applicationIdA + '/verifications', irisKey, {});
    expect(foreignVerification.status).toBe(404);

    const intruded = await prisma.applicationFile.count({
      where: { applicationId: applicationIdA, path: 'src/foreign.ts' },
    });
    expect(intruded).toBe(0);
    const application = await prisma.application.findUnique({ where: { id: applicationIdA } });
    expect(application?.status).toBe('PLANNING');
    const checkpointCount = await prisma.checkpoint.count({ where: { applicationId: applicationIdA } });
    expect(checkpointCount).toBe(0);
  });

  it('snapshots and restores checkpoints through the key with idempotent replay', async () => {
    const checkpoint = await genapi(
      'applications/' + applicationIdA + '/checkpoints',
      writerKey,
      { label: 'before-drift' },
    );
    expect(checkpoint.status).toBe(201);
    const checkpointId = (checkpoint.body as { id: string }).id;
    expect((checkpoint.body as { label: string }).label).toBe('before-drift');
    expect((checkpoint.body as { fileCount: number }).fileCount).toBe(1);

    const drifted = await writeFile(
      writerKey,
      applicationIdA,
      'src/index.ts',
      'export const answer = 999;',
      4,
    );
    expect(drifted.status).toBe(201);
    expect((drifted.body as { revision: number }).revision).toBe(5);

    const restored = await genapi(
      'applications/' + applicationIdA + '/checkpoints/' + checkpointId + '/restore',
      writerKey,
    );
    expect(restored.status).toBe(201);
    expect((restored.body as { changedFiles: number }).changedFiles).toBe(1);

    const replay = await genapi(
      'applications/' + applicationIdA + '/checkpoints/' + checkpointId + '/restore',
      writerKey,
    );
    expect(replay.status).toBe(201);
    expect((replay.body as { changedFiles: number }).changedFiles).toBe(0);

    const row = await prisma.applicationFile.findUnique({
      where: { applicationId_path: { applicationId: applicationIdA, path: 'src/index.ts' } },
    });
    expect(row?.revision).toBe(6);
  });

  it('runs verifications through the key with honest attribution', async () => {
    const runs = await genapi('applications/' + applicationIdA + '/verifications', writerKey, {});
    expect(runs.status).toBe(201);
    const runList = runs.body as unknown as Array<{ kind: string; status: string }>;
    expect(runList).toHaveLength(3);
    for (const run of runList) {
      expect(['STATIC_ANALYSIS', 'SECRET_SCAN', 'DEPENDENCY_AUDIT']).toContain(run.kind);
      expect(['PASSED', 'SKIPPED']).toContain(run.status);
    }

    const refused = await genapi('applications/' + applicationIdA + '/verifications', readerKey, {});
    expect(refused.status).toBe(403);

    const attributed = await prisma.verificationRun.count({
      where: { applicationId: applicationIdA, triggeredBy: hank.userId },
    });
    expect(attributed).toBe(3);
  });

  it('archives and restores through the key with clean double-taps', async () => {
    const second = await api(
      'POST',
      '/projects/' + projectIdA + '/applications',
      { name: 'Genapi Archive App' },
      hank.tokens.accessToken,
    );
    expect(second.status).toBe(201);
    const applicationIdA2 = (second.body as { id: string }).id;

    const archived = await genapi('applications/' + applicationIdA2 + '/archive', writerKey, {});
    expect(archived.status).toBe(201);
    expect((archived.body as { status: string }).status).toBe('ARCHIVED');

    const writeWhileArchived = await writeFile(writerKey, applicationIdA2, 'src/blocked.ts', 'export const blocked = true;');
    expect(writeWhileArchived.status).toBe(404);

    const archiveDoubleTap = await genapi('applications/' + applicationIdA2 + '/archive', writerKey, {});
    expect(archiveDoubleTap.status).toBe(404);

    const foreignArchive = await genapi('applications/' + applicationIdA2 + '/archive', irisKey, {});
    expect(foreignArchive.status).toBe(404);

    const restored = await genapi('applications/' + applicationIdA2 + '/restore', writerKey, {});
    expect(restored.status).toBe(201);
    expect((restored.body as { status: string }).status).toBe('PLANNING');

    const restoreDoubleTap = await genapi('applications/' + applicationIdA2 + '/restore', writerKey, {});
    expect(restoreDoubleTap.status).toBe(404);
  });

  it('stops a revoked key instantly with no side effects', async () => {
    const created = await createKey(hank.tokens.accessToken, organizationIdA, 'doomed', ['WRITE_APPLICATIONS']);
    expect(created.status).toBe(201);
    const doomedKey = (created.body as { key: string }).key;
    const doomedKeyId = (created.body as { id: string }).id;

    const revoke = await api(
      'POST',
      '/organizations/' + organizationIdA + '/api-keys/' + doomedKeyId + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect(revoke.status).toBe(201);

    const refused = await writeFile(doomedKey, applicationIdA, 'src/revoked.ts', 'export const revoked = true;');
    expect(refused.status).toBe(401);
    const count = await prisma.applicationFile.count({
      where: { applicationId: applicationIdA, path: 'src/revoked.ts' },
    });
    expect(count).toBe(0);
  });

  it('honors expiry for writes', async () => {
    const expiresAt = new Date(Date.now() + 2000).toISOString();
    const created = await createKey(
      hank.tokens.accessToken,
      organizationIdA,
      'fleeting',
      ['WRITE_APPLICATIONS'],
      expiresAt,
    );
    expect(created.status).toBe(201);
    const fleetingKey = (created.body as { key: string }).key;

    const before = await writeFile(fleetingKey, applicationIdA, 'src/expiring.ts', 'export const expiring = true;');
    expect(before.status).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const after = await writeFile(fleetingKey, applicationIdA, 'src/expiring.ts', 'export const expiring = false;', 1);
    expect(after.status).toBe(401);

    const revisionCount = await prisma.fileRevision.count({
      where: { file: { applicationId: applicationIdA, path: 'src/expiring.ts' } },
    });
    expect(revisionCount).toBe(1);
  });

  it('rejects missing and unknown credentials with a uniform 401', async () => {
    const noAuth = await writeFile(undefined, applicationIdA, 'src/no-auth.ts', 'export const x = 1;');
    expect(noAuth.status).toBe(401);
    const unknown = await writeFile('gn_live_' + 'a'.repeat(43), applicationIdA, 'src/unknown-key.ts', 'export const x = 2;');
    expect(unknown.status).toBe(401);
  });

  it('stamps key actions honestly in the audit trail', async () => {
    const archiveAudit = await prisma.auditEvent.findFirst({
      where: {
        action: 'application.archive',
        organizationId: organizationIdA,
        metadata: { path: ['via'], equals: 'genapi' },
      },
    });
    expect(archiveAudit).not.toBeNull();
    expect(archiveAudit?.actorUserId).toBe(hank.userId);

    const restoreAudit = await prisma.auditEvent.findFirst({
      where: {
        action: 'application.checkpoint.restore',
        organizationId: organizationIdA,
        metadata: { path: ['apiKeyId'], equals: writerKeyId },
      },
    });
    expect(restoreAudit).not.toBeNull();
    expect(restoreAudit?.actorUserId).toBe(hank.userId);

    const verificationAudit = await prisma.auditEvent.findFirst({
      where: {
        action: 'application.verification.run',
        metadata: { path: ['via'], equals: 'genapi' },
      },
    });
    expect(verificationAudit).not.toBeNull();
  });
});
