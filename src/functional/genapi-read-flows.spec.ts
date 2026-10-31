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

suite('genapi key-authenticated read flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let hank: UserContext;
  let iris: UserContext;
  let projectIdA: string;
  let applicationIdA: string;
  let applicationIdB: string;
  let indexFileId: string;
  let tempFileId: string;
  let readerKey: string;
  let readerKeyId: string;
  let writerOnlyKey: string;
  let irisReaderKey: string;
  const seedRunIds: string[] = [];
  let foreignRunId: string;
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

  const genapiGet = (path: string, key: string | undefined) =>
    api('GET', '/genapi/' + path, undefined, key);

  const registerUser = async (name: string): Promise<UserContext> => {
    const email = 'genesis-read-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'genapi-read-test-password-123',
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

  const seedTenant = async (owner: UserContext, projectName: string, appName: string) => {
    const orgs = await api('GET', '/organizations', undefined, owner.tokens.accessToken);
    expect(orgs.status).toBe(200);
    const organizationId = (orgs.body as unknown as Array<{ id: string }>)[0].id;
    const workspaces = await api('GET', '/workspaces', undefined, owner.tokens.accessToken);
    expect(workspaces.status).toBe(200);
    const workspaceId = (workspaces.body as unknown as Array<{ id: string }>)[0].id;
    const project = await api(
      'POST',
      '/workspaces/' + workspaceId + '/projects',
      { name: projectName },
      owner.tokens.accessToken,
    );
    expect(project.status).toBe(201);
    const projectId = (project.body as { id: string }).id;
    const application = await api(
      'POST',
      '/projects/' + projectId + '/applications',
      { name: appName },
      owner.tokens.accessToken,
    );
    expect(application.status).toBe(201);
    return {
      organizationId,
      projectId,
      applicationId: (application.body as { id: string }).id,
    };
  };

  const writeJwt = (owner: UserContext, applicationId: string, path: string, content: string) =>
    api('POST', '/applications/' + applicationId + '/files', { path, content }, owner.tokens.accessToken);

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
    if (createdUserIds.length > 0) {
      const { PrismaService } = await import('../database/prisma.service');
      const prisma = app.get(PrismaService);
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('seeds two tenants, content, and keys with distinct scopes', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const tenantA = await seedTenant(hank, 'Genapi Read Project', 'Genapi Read App');
    projectIdA = tenantA.projectId;
    applicationIdA = tenantA.applicationId;
    const tenantB = await seedTenant(iris, 'Iris Read Project', 'Iris Read App');
    applicationIdB = tenantB.applicationId;

    const index = await writeJwt(hank, applicationIdA, 'src/index.ts', 'export const answer = 42;');
    expect(index.status).toBe(201);
    indexFileId = (index.body as { id: string }).id;
    const util = await writeJwt(hank, applicationIdA, 'src/util.ts', 'export const help = true;');
    expect(util.status).toBe(201);
    const temp = await writeJwt(hank, applicationIdA, 'src/temp.ts', 'export const temp = 1;');
    expect(temp.status).toBe(201);
    tempFileId = (temp.body as { id: string }).id;

    const checkpoint = await api(
      'POST',
      '/applications/' + applicationIdA + '/checkpoints',
      { label: 'seed-checkpoint' },
      hank.tokens.accessToken,
    );
    expect(checkpoint.status).toBe(201);

    const runs = await api(
      'POST',
      '/applications/' + applicationIdA + '/verifications',
      {},
      hank.tokens.accessToken,
    );
    expect(runs.status).toBe(201);
    for (const run of runs.body as unknown as Array<{ id: string }>) {
      seedRunIds.push(run.id);
    }
    expect(seedRunIds).toHaveLength(3);

    const irisFile = await writeJwt(iris, applicationIdB, 'src/foreign.ts', 'export const x = 1;');
    expect(irisFile.status).toBe(201);
    const irisRuns = await api(
      'POST',
      '/applications/' + applicationIdB + '/verifications',
      {},
      iris.tokens.accessToken,
    );
    expect(irisRuns.status).toBe(201);
    foreignRunId = (irisRuns.body as unknown as Array<{ id: string }>)[0].id;

    const reader = await createKey(hank.tokens.accessToken, tenantA.organizationId, 'reader', ['READ_APPLICATIONS']);
    expect(reader.status).toBe(201);
    readerKey = (reader.body as { key: string }).key;
    readerKeyId = (reader.body as { id: string }).id;

    const writerOnly = await createKey(hank.tokens.accessToken, tenantA.organizationId, 'writer-only', ['WRITE_APPLICATIONS']);
    expect(writerOnly.status).toBe(201);
    writerOnlyKey = (writerOnly.body as { key: string }).key;

    const irisReader = await createKey(iris.tokens.accessToken, tenantB.organizationId, 'iris-reader', ['READ_APPLICATIONS']);
    expect(irisReader.status).toBe(201);
    irisReaderKey = (irisReader.body as { key: string }).key;
  });

  it('lists files for a read-scoped key with shape parity and no content', async () => {
    const listed = await genapiGet('applications/' + applicationIdA + '/files', readerKey);
    expect(listed.status).toBe(200);
    const items = listed.body as unknown as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.path)).toEqual(['src/index.ts', 'src/temp.ts', 'src/util.ts']);
    for (const item of items) {
      expect(item.content).toBeUndefined();
      expect(String(item.contentHash)).toMatch(/^[a-f0-9]{64}$/);
    }

    const jwtListed = await api('GET', '/applications/' + applicationIdA + '/files', undefined, hank.tokens.accessToken);
    expect(jwtListed.status).toBe(200);
    expect(items).toEqual(jwtListed.body as unknown as Array<Record<string, unknown>>);
  });

  it('reads a single file for a key and refuses unknown file ids', async () => {
    const read = await genapiGet('applications/' + applicationIdA + '/files/' + indexFileId, readerKey);
    expect(read.status).toBe(200);
    expect((read.body as { id: string }).id).toBe(indexFileId);
    expect((read.body as { path: string }).path).toBe('src/index.ts');
    expect((read.body as { content: string }).content).toBe('export const answer = 42;');

    const unknown = await genapiGet('applications/' + applicationIdA + '/files/unknown-file-id', readerKey);
    expect(unknown.status).toBe(404);
  });

  it('hides deleted files from keyed reads exactly like the JWT surface', async () => {
    const removed = await api(
      'DELETE',
      '/applications/' + applicationIdA + '/files/' + tempFileId + '/revision/1',
      undefined,
      hank.tokens.accessToken,
    );
    expect(removed.status).toBe(200);

    const listed = await genapiGet('applications/' + applicationIdA + '/files', readerKey);
    expect(listed.status).toBe(200);
    expect((listed.body as unknown as Array<Record<string, unknown>>).map((item) => item.path))
      .toEqual(['src/index.ts', 'src/util.ts']);

    const read = await genapiGet('applications/' + applicationIdA + '/files/' + tempFileId, readerKey);
    expect(read.status).toBe(404);
  });

  it('refuses a write-only key on every read endpoint', async () => {
    const paths = [
      'applications/' + applicationIdA + '/files',
      'applications/' + applicationIdA + '/files/' + indexFileId,
      'applications/' + applicationIdA + '/checkpoints',
      'applications/' + applicationIdA + '/verifications',
      'applications/' + applicationIdA + '/verifications/' + seedRunIds[0],
    ];
    for (const path of paths) {
      const refused = await genapiGet(path, writerOnlyKey);
      expect(refused.status).toBe(403);
    }
  });

  it('refuses a foreign key with the same uniform 404 on every read endpoint', async () => {
    const paths = [
      'applications/' + applicationIdA + '/files',
      'applications/' + applicationIdA + '/files/' + indexFileId,
      'applications/' + applicationIdA + '/checkpoints',
      'applications/' + applicationIdA + '/verifications',
      'applications/' + applicationIdA + '/verifications/' + seedRunIds[0],
    ];
    const messages = new Set<string>();
    for (const path of paths) {
      const refused = await genapiGet(path, irisReaderKey);
      expect(refused.status).toBe(404);
      messages.add(String((refused.body as { message?: string }).message));
    }
    expect(messages.size).toBe(1);
  });

  it('refuses unknown applications with the same uniform 404', async () => {
    const paths = [
      'applications/unknown-application-id/files',
      'applications/unknown-application-id/files/unknown-file-id',
      'applications/unknown-application-id/checkpoints',
      'applications/unknown-application-id/verifications',
      'applications/unknown-application-id/verifications/unknown-run-id',
    ];
    for (const path of paths) {
      const refused = await genapiGet(path, readerKey);
      expect(refused.status).toBe(404);
    }
  });

  it('lists checkpoints for a key with honest attribution', async () => {
    const listed = await genapiGet('applications/' + applicationIdA + '/checkpoints', readerKey);
    expect(listed.status).toBe(200);
    const items = listed.body as unknown as Array<{ id: string; label: string; fileCount: number; createdBy: string | null }>;
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('seed-checkpoint');
    expect(items[0].fileCount).toBe(3);
    expect(items[0].createdBy).toBe(hank.userId);
  });

  it('lists verifications for a key with parity against the JWT surface', async () => {
    const listed = await genapiGet('applications/' + applicationIdA + '/verifications', readerKey);
    expect(listed.status).toBe(200);
    const items = listed.body as unknown as Array<{ id: string; kind: string; status: string }>;
    expect(items.map((item) => item.id).sort()).toEqual([...seedRunIds].sort());
    for (const item of items) {
      expect(['STATIC_ANALYSIS', 'SECRET_SCAN', 'DEPENDENCY_AUDIT']).toContain(item.kind);
      expect(['PASSED', 'SKIPPED']).toContain(item.status);
    }

    const jwtListed = await api('GET', '/applications/' + applicationIdA + '/verifications', undefined, hank.tokens.accessToken);
    expect(jwtListed.status).toBe(200);
    expect(items.map((item) => item.id).sort())
      .toEqual((jwtListed.body as unknown as Array<{ id: string }>).map((item) => item.id).sort());
  });

  it('inspects a verification run for a key and keeps foreign runs invisible', async () => {
    const inspected = await genapiGet(
      'applications/' + applicationIdA + '/verifications/' + seedRunIds[0],
      readerKey,
    );
    expect(inspected.status).toBe(200);
    const run = inspected.body as { id: string; kind: string; status: string; triggeredBy: string | null; findings: unknown };
    expect(run.id).toBe(seedRunIds[0]);
    expect(run.triggeredBy).toBe(hank.userId);
    // The body crossed an HTTP JSON boundary, so an instanceof check against
    // the test realm Object is unreliable. Assert the real persisted shape
    // instead: findings always carries the counts object and the items array.
    const findings = run.findings as { counts?: unknown; items?: unknown };
    expect(findings).not.toBeNull();
    expect(typeof findings).toBe('object');
    expect(typeof findings.counts).toBe('object');
    expect(Array.isArray(findings.items)).toBe(true);

    const unknown = await genapiGet(
      'applications/' + applicationIdA + '/verifications/unknown-run-id',
      readerKey,
    );
    expect(unknown.status).toBe(404);

    const foreign = await genapiGet(
      'applications/' + applicationIdA + '/verifications/' + foreignRunId,
      readerKey,
    );
    expect(foreign.status).toBe(404);
  });

  it('keeps reads working on an archived application while writes stay blocked', async () => {
    const archived = await api(
      'POST',
      '/projects/' + projectIdA + '/applications/' + applicationIdA + '/archive',
      {},
      hank.tokens.accessToken,
    );
    expect(archived.status).toBe(201);

    const files = await genapiGet('applications/' + applicationIdA + '/files', readerKey);
    expect(files.status).toBe(200);
    expect((files.body as unknown as Array<Record<string, unknown>>)).toHaveLength(2);

    const read = await genapiGet('applications/' + applicationIdA + '/files/' + indexFileId, readerKey);
    expect(read.status).toBe(200);

    const checkpoints = await genapiGet('applications/' + applicationIdA + '/checkpoints', readerKey);
    expect(checkpoints.status).toBe(200);

    const verifications = await genapiGet('applications/' + applicationIdA + '/verifications', readerKey);
    expect(verifications.status).toBe(200);

    const write = await api(
      'POST',
      '/genapi/applications/' + applicationIdA + '/files',
      { path: 'src/blocked.ts', content: 'export const blocked = true;' },
      writerOnlyKey,
    );
    expect(write.status).toBe(404);
  });

  it('stops a revoked key instantly on reads', async () => {
    const orgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    const organizationId = (orgs.body as unknown as Array<{ id: string }>)[0].id;
    const created = await createKey(hank.tokens.accessToken, organizationId, 'doomed-reader', ['READ_APPLICATIONS']);
    expect(created.status).toBe(201);
    const doomedKey = (created.body as { key: string }).key;
    const doomedKeyId = (created.body as { id: string }).id;

    const revoke = await api(
      'POST',
      '/organizations/' + organizationId + '/api-keys/' + doomedKeyId + '/revoke',
      {},
      hank.tokens.accessToken,
    );
    expect(revoke.status).toBe(201);

    const refused = await genapiGet('applications/' + applicationIdA + '/files', doomedKey);
    expect(refused.status).toBe(401);
  });

  it('honors expiry on reads', async () => {
    const orgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    const organizationId = (orgs.body as unknown as Array<{ id: string }>)[0].id;
    const expiresAt = new Date(Date.now() + 2000).toISOString();
    const created = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'fleeting-reader',
      ['READ_APPLICATIONS'],
      expiresAt,
    );
    expect(created.status).toBe(201);
    const fleetingKey = (created.body as { key: string }).key;

    const before = await genapiGet('applications/' + applicationIdA + '/files', fleetingKey);
    expect(before.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const after = await genapiGet('applications/' + applicationIdA + '/files', fleetingKey);
    expect(after.status).toBe(401);
  });

  it('rejects missing credentials with a uniform 401 on every read endpoint', async () => {
    const paths = [
      'applications/' + applicationIdA + '/files',
      'applications/' + applicationIdA + '/files/' + indexFileId,
      'applications/' + applicationIdA + '/checkpoints',
      'applications/' + applicationIdA + '/verifications',
      'applications/' + applicationIdA + '/verifications/' + seedRunIds[0],
    ];
    for (const path of paths) {
      const refused = await genapiGet(path, undefined);
      expect(refused.status).toBe(401);
    }
  });
});
