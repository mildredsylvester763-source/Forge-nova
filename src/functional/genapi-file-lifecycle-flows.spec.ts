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
 * Key-authenticated file lifecycle against the real app and the real
 * CI PostgreSQL: revision history, restore, and delete. Grounded in
 * the market leaders: the GitHub commit listing keeps file history
 * readable with nothing more than read access, newest first; the
 * GitHub contents update and the Vercel instant rollback both model
 * a restore as a fresh write on top of history behind write
 * permission; and the GitHub contents delete demands write
 * permission, carries the expected state token in the request, and
 * warns that concurrent deletes conflict, so exactly one tombstone
 * can ever land. The keyed routes mirror the JWT routes exactly,
 * tenant-bounded to the key organization with uniform 404s, and the
 * file lifecycle writes no audit rows exactly like the JWT file
 * surface.
 */
suite('GENESIS genapi file lifecycle flows (real app, real database)', () => {
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
  const createdFileIds: string[] = [];
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
    const email = 'genesis-filelc-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'file-lifecycle-password-123',
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

  const writeFileKeyed = (
    applicationId: string,
    path: string,
    content: string,
    expectedRevision: number | undefined,
    key: string,
  ) =>
    api(
      'POST',
      '/genapi/applications/' + applicationId + '/files',
      expectedRevision === undefined
        ? { path, content }
        : { path, content, expectedRevision },
      key,
    );

  const writeFileJwt = (
    applicationId: string,
    path: string,
    content: string,
    expectedRevision: number | undefined,
  ) =>
    api(
      'POST',
      '/applications/' + applicationId + '/files',
      expectedRevision === undefined
        ? { path, content }
        : { path, content, expectedRevision },
      hank.tokens.accessToken,
    );

  const revisionsKeyed = (applicationId: string, fileId: string, key?: string) =>
    api('GET', '/genapi/applications/' + applicationId + '/files/' + fileId + '/revisions', undefined, key);

  const revisionsJwt = (applicationId: string, fileId: string) =>
    api('GET', '/applications/' + applicationId + '/files/' + fileId + '/revisions', undefined, hank.tokens.accessToken);

  const restoreKeyed = (
    applicationId: string,
    fileId: string,
    revision: number,
    expectedCurrentRevision: number,
    key?: string,
  ) =>
    api(
      'POST',
      '/genapi/applications/' + applicationId + '/files/' + fileId + '/restore/' + revision,
      { expectedCurrentRevision },
      key,
    );

  const restoreJwt = (
    applicationId: string,
    fileId: string,
    revision: number,
    expectedCurrentRevision: number,
  ) =>
    api(
      'POST',
      '/applications/' + applicationId + '/files/' + fileId + '/restore/' + revision,
      { expectedCurrentRevision },
      hank.tokens.accessToken,
    );

  const deleteKeyed = (applicationId: string, fileId: string, expectedRevision: number, key?: string) =>
    api(
      'POST',
      '/genapi/applications/' + applicationId + '/files/' + fileId + '/delete/revision/' + expectedRevision,
      undefined,
      key,
    );

  const deleteJwt = (applicationId: string, fileId: string, expectedRevision: number) =>
    api(
      'DELETE',
      '/applications/' + applicationId + '/files/' + fileId + '/revision/' + expectedRevision,
      undefined,
      hank.tokens.accessToken,
    );

  const readKeyed = (applicationId: string, fileId: string, key: string) =>
    api('GET', '/genapi/applications/' + applicationId + '/files/' + fileId, undefined, key);

  const fileRow = (fileId: string) =>
    prisma.applicationFile.findUnique({
      where: { id: fileId },
      select: { revision: true, isDeleted: true, content: true },
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
    if (createdFileIds.length > 0) {
      await prisma.fileRevision.deleteMany({ where: { fileId: { in: createdFileIds } } });
      await prisma.applicationFile.deleteMany({ where: { id: { in: createdFileIds } } });
    }
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

    mainProjectId = await createProject(hank.tokens.accessToken, workspaceAId, 'File Lifecycle Project ' + runId);
    const foreignProjectId = await createProject(iris.tokens.accessToken, foreignWorkspaceId, 'Foreign File Lifecycle Project ' + runId);

    applicationAId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Filelc App A ' + runId);
    applicationBId = await createApplication(hank.tokens.accessToken, mainProjectId, 'Filelc App B ' + runId);
    foreignApplicationId = await createApplication(iris.tokens.accessToken, foreignProjectId, 'Foreign Filelc App ' + runId);

    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'Filelc Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
    readerKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Filelc Reader',
      ['READ_APPLICATIONS'],
    );
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Filelc Short Lived',
      ['WRITE_APPLICATIONS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Filelc Revoked',
      ['WRITE_APPLICATIONS'],
    );
    irisWriter = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Foreign Filelc Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
  });

  it('lists keyed revisions that mirror the JWT revision surface exactly', async () => {
    const path = 'src/parity-' + runId + '.ts';
    const written = await writeFileJwt(applicationAId, path, 'const greeting = 1;', undefined);
    expect(written.status).toBe(201);
    const fileId = (written.body as { id: string }).id;
    createdFileIds.push(fileId);
    const updated = await writeFileKeyed(applicationAId, path, 'const greeting = 2;', 1, writerKey.key);
    expect(updated.status).toBe(201);

    const keyed = await revisionsKeyed(applicationAId, fileId, readerKey.key);
    expect(keyed.status).toBe(200);
    const jwt = await revisionsJwt(applicationAId, fileId);
    expect(jwt.status).toBe(200);
    expect(keyed.body).toEqual(jwt.body);

    const rows = keyed.body as unknown as Array<{ revision: number; isDeleted: boolean; createdBy: string }>;
    expect(rows.length).toBe(2);
    expect(rows[0].revision).toBe(2);
    expect(rows[1].revision).toBe(1);
    expect(rows.every((row) => row.createdBy === hank.userId)).toBe(true);
  });

  it('restores an old revision through the keyed surface and mirrors the JWT shape', async () => {
    const keyedPath = 'src/restore-keyed-' + runId + '.ts';
    const jwtPath = 'src/restore-jwt-' + runId + '.ts';
    const keyedWritten = await writeFileKeyed(applicationAId, keyedPath, 'const greeting = 1;', undefined, writerKey.key);
    expect(keyedWritten.status).toBe(201);
    const keyedFileId = (keyedWritten.body as { id: string }).id;
    createdFileIds.push(keyedFileId);
    const keyedUpdated = await writeFileKeyed(applicationAId, keyedPath, 'const greeting = 2;', 1, writerKey.key);
    expect(keyedUpdated.status).toBe(201);

    const keyed = await restoreKeyed(applicationAId, keyedFileId, 1, 2, writerKey.key);
    expect(keyed.status).toBe(201);
    expect(Object.keys(keyed.body).sort()).toEqual(['applicationId', 'contentHash', 'id', 'isDeleted', 'path', 'restoredFromRevision', 'revision']);
    expect((keyed.body as { restoredFromRevision: number }).restoredFromRevision).toBe(1);
    expect((keyed.body as { revision: number }).revision).toBe(3);
    expect((keyed.body as { isDeleted: boolean }).isDeleted).toBe(false);

    const keyedRead = await readKeyed(applicationAId, keyedFileId, readerKey.key);
    expect(keyedRead.status).toBe(200);
    expect((keyedRead.body as { content: string }).content).toBe('const greeting = 1;');

    const jwtWritten = await writeFileJwt(applicationAId, jwtPath, 'const greeting = 1;', undefined);
    expect(jwtWritten.status).toBe(201);
    const jwtFileId = (jwtWritten.body as { id: string }).id;
    createdFileIds.push(jwtFileId);
    const jwtUpdated = await writeFileJwt(applicationAId, jwtPath, 'const greeting = 2;', 1);
    expect(jwtUpdated.status).toBe(201);

    const jwt = await restoreJwt(applicationAId, jwtFileId, 1, 2);
    expect(jwt.status).toBe(200);
    expect(Object.keys(jwt.body).sort()).toEqual(Object.keys(keyed.body).sort());
    expect((jwt.body as { restoredFromRevision: number }).restoredFromRevision).toBe(1);
    expect((jwt.body as { revision: number }).revision).toBe(3);
  });

  it('refuses a stale restore with the honest conflict', async () => {
    const path = 'src/stale-restore-' + runId + '.ts';
    const written = await writeFileKeyed(applicationAId, path, 'const greeting = 1;', undefined, writerKey.key);
    expect(written.status).toBe(201);
    const fileId = (written.body as { id: string }).id;
    createdFileIds.push(fileId);
    const updated = await writeFileKeyed(applicationAId, path, 'const greeting = 2;', 1, writerKey.key);
    expect(updated.status).toBe(201);

    const stale = await restoreKeyed(applicationAId, fileId, 1, 999, writerKey.key);
    expect(stale.status).toBe(409);
    expect((stale.body as { message: string }).message).toBe('The file changed since it was read.');
    expect((stale.body as { expectedRevision: number }).expectedRevision).toBe(999);
    expect((stale.body as { currentRevision: number }).currentRevision).toBe(2);
  });

  it('refuses an unknown target revision with the uniform 404', async () => {
    const path = 'src/unknown-revision-' + runId + '.ts';
    const written = await writeFileKeyed(applicationAId, path, 'const greeting = 1;', undefined, writerKey.key);
    expect(written.status).toBe(201);
    const fileId = (written.body as { id: string }).id;
    createdFileIds.push(fileId);

    const refused = await restoreKeyed(applicationAId, fileId, 999, 1, writerKey.key);
    expect(refused.status).toBe(404);
    expect((refused.body as { message: string }).message).toBe('The requested file revision was not found.');
  });

  it('deletes through the keyed surface and mirrors the JWT tombstone', async () => {
    const keyedPath = 'src/delete-keyed-' + runId + '.ts';
    const jwtPath = 'src/delete-jwt-' + runId + '.ts';
    const keyedWritten = await writeFileKeyed(applicationAId, keyedPath, 'const greeting = 1;', undefined, writerKey.key);
    expect(keyedWritten.status).toBe(201);
    const keyedFileId = (keyedWritten.body as { id: string }).id;
    createdFileIds.push(keyedFileId);
    const jwtWritten = await writeFileJwt(applicationAId, jwtPath, 'const greeting = 1;', undefined);
    expect(jwtWritten.status).toBe(201);
    const jwtFileId = (jwtWritten.body as { id: string }).id;
    createdFileIds.push(jwtFileId);

    const keyed = await deleteKeyed(applicationAId, keyedFileId, 1, writerKey.key);
    expect(keyed.status).toBe(201);
    expect(Object.keys(keyed.body).sort()).toEqual(['deleted', 'id', 'path', 'revision']);
    expect((keyed.body as { deleted: boolean }).deleted).toBe(true);
    expect((keyed.body as { revision: number }).revision).toBe(2);

    const jwt = await deleteJwt(applicationAId, jwtFileId, 1);
    expect(jwt.status).toBe(200);
    expect(Object.keys(jwt.body).sort()).toEqual(['deleted', 'id', 'path', 'revision']);

    const refusedRead = await readKeyed(applicationAId, keyedFileId, readerKey.key);
    expect(refusedRead.status).toBe(404);
    expect((refusedRead.body as { message: string }).message).toBe('Application file not found.');

    const history = await revisionsKeyed(applicationAId, keyedFileId, readerKey.key);
    expect(history.status).toBe(200);
    const rows = history.body as unknown as Array<{ revision: number; isDeleted: boolean }>;
    expect(rows.length).toBe(2);
    expect(rows[0].revision).toBe(2);
    expect(rows[0].isDeleted).toBe(true);
  });

  it('refuses a stale delete with the honest conflict', async () => {
    const path = 'src/stale-delete-' + runId + '.ts';
    const written = await writeFileKeyed(applicationAId, path, 'const greeting = 1;', undefined, writerKey.key);
    expect(written.status).toBe(201);
    const fileId = (written.body as { id: string }).id;
    createdFileIds.push(fileId);

    const stale = await deleteKeyed(applicationAId, fileId, 999, writerKey.key);
    expect(stale.status).toBe(409);
    expect((stale.body as { message: string }).message).toBe('The file changed since it was read.');
    expect((stale.body as { expectedRevision: number }).expectedRevision).toBe(999);
    expect((stale.body as { currentRevision: number }).currentRevision).toBe(1);
  });

  it('lands exactly one tombstone on a delete double-tap', async () => {
    const path = 'src/double-delete-' + runId + '.ts';
    const written = await writeFileKeyed(applicationAId, path, 'const greeting = 1;', undefined, writerKey.key);
    expect(written.status).toBe(201);
    const fileId = (written.body as { id: string }).id;
    createdFileIds.push(fileId);

    const raced = await Promise.all([
      deleteKeyed(applicationAId, fileId, 1, writerKey.key),
      deleteKeyed(applicationAId, fileId, 1, writerKey.key),
    ]);
    const statuses = raced.map((outcome) => outcome.status);
    expect(statuses.filter((status) => status === 201).length).toBe(1);
    expect(statuses.every((status) => status === 201 || status === 404 || status === 409)).toBe(true);

    const loser = raced.find((outcome) => outcome.status !== 201)!;
    const loserMessage = (loser.body as { message: string }).message;
    expect(
      loserMessage === 'Application file not found.'
      || loserMessage === 'The file changed concurrently; read it again before retrying.',
    ).toBe(true);

    const row = await fileRow(fileId);
    expect(row!.isDeleted).toBe(true);
    expect(row!.revision).toBe(2);
    const tombstones = await prisma.fileRevision.count({ where: { fileId, isDeleted: true } });
    expect(tombstones).toBe(1);
  });

  it('races a delete against a write into exactly one clean winner', async () => {
    const path = 'src/delete-write-race-' + runId + '.ts';
    const written = await writeFileKeyed(applicationAId, path, 'const greeting = 1;', undefined, writerKey.key);
    expect(written.status).toBe(201);
    const fileId = (written.body as { id: string }).id;
    createdFileIds.push(fileId);

    const raced = await Promise.all([
      writeFileKeyed(applicationAId, path, 'const greeting = 2;', 1, writerKey.key),
      deleteKeyed(applicationAId, fileId, 1, writerKey.key),
    ]);
    const statuses = raced.map((outcome) => outcome.status);
    expect(statuses.filter((status) => status === 201).length).toBe(1);
    expect(statuses.every((status) => status === 201 || status === 404 || status === 409)).toBe(true);

    const row = await fileRow(fileId);
    expect(row!.revision).toBe(2);
    const deleteWon = statuses.indexOf(201) === 1;
    if (deleteWon) {
      expect(row!.isDeleted).toBe(true);
    } else {
      expect(row!.isDeleted).toBe(false);
      expect(row!.content).toBe('const greeting = 2;');
    }
    const chain = await prisma.fileRevision.findMany({
      where: { fileId },
      orderBy: { revision: 'asc' },
      select: { revision: true },
    });
    expect(chain.map((entry) => entry.revision)).toEqual([1, 2]);
  });

  it('races a restore against a delete into exactly one clean winner', async () => {
    const path = 'src/restore-delete-race-' + runId + '.ts';
    const written = await writeFileKeyed(applicationAId, path, 'const greeting = 1;', undefined, writerKey.key);
    expect(written.status).toBe(201);
    const fileId = (written.body as { id: string }).id;
    createdFileIds.push(fileId);
    const updated = await writeFileKeyed(applicationAId, path, 'const greeting = 2;', 1, writerKey.key);
    expect(updated.status).toBe(201);

    const raced = await Promise.all([
      restoreKeyed(applicationAId, fileId, 1, 2, writerKey.key),
      deleteKeyed(applicationAId, fileId, 2, writerKey.key),
    ]);
    const statuses = raced.map((outcome) => outcome.status);
    expect(statuses.filter((status) => status === 201).length).toBe(1);
    expect(statuses.every((status) => status === 201 || status === 404 || status === 409)).toBe(true);

    const row = await fileRow(fileId);
    expect(row!.revision).toBe(3);
    const restoreWon = statuses.indexOf(201) === 0;
    if (restoreWon) {
      expect(row!.isDeleted).toBe(false);
      expect(row!.content).toBe('const greeting = 1;');
    } else {
      expect(row!.isDeleted).toBe(true);
    }
    const chain = await prisma.fileRevision.findMany({
      where: { fileId },
      orderBy: { revision: 'asc' },
      select: { revision: true },
    });
    expect(chain.map((entry) => entry.revision)).toEqual([1, 2, 3]);
  });

  it('tenant-bounds all three routes with two uniform 404s', async () => {
    const ownPath = 'src/tenant-own-' + runId + '.ts';
    const own = await writeFileKeyed(applicationAId, ownPath, 'const greeting = 1;', undefined, writerKey.key);
    expect(own.status).toBe(201);
    const ownFileId = (own.body as { id: string }).id;
    createdFileIds.push(ownFileId);

    const foreignPath = 'src/tenant-foreign-' + runId + '.ts';
    const foreign = await writeFileKeyed(foreignApplicationId, foreignPath, 'const greeting = 1;', undefined, irisWriter.key);
    expect(foreign.status).toBe(201);
    const foreignFileId = (foreign.body as { id: string }).id;
    createdFileIds.push(foreignFileId);

    const applicationMessages = new Set<string>();
    const fileMessages = new Set<string>();

    const foreignKeyRevisions = await revisionsKeyed(applicationAId, ownFileId, irisWriter.key);
    expect(foreignKeyRevisions.status).toBe(404);
    applicationMessages.add((foreignKeyRevisions.body as { message: string }).message);

    const foreignKeyRestore = await restoreKeyed(applicationAId, ownFileId, 1, 1, irisWriter.key);
    expect(foreignKeyRestore.status).toBe(404);
    applicationMessages.add((foreignKeyRestore.body as { message: string }).message);

    const foreignKeyDelete = await deleteKeyed(applicationAId, ownFileId, 1, irisWriter.key);
    expect(foreignKeyDelete.status).toBe(404);
    applicationMessages.add((foreignKeyDelete.body as { message: string }).message);

    const foreignApplication = await revisionsKeyed(foreignApplicationId, foreignFileId, writerKey.key);
    expect(foreignApplication.status).toBe(404);
    applicationMessages.add((foreignApplication.body as { message: string }).message);

    const unknownApplication = await deleteKeyed('does-not-exist-at-all', ownFileId, 1, writerKey.key);
    expect(unknownApplication.status).toBe(404);
    applicationMessages.add((unknownApplication.body as { message: string }).message);

    const unknownFile = await revisionsKeyed(applicationAId, 'does-not-exist-at-all', writerKey.key);
    expect(unknownFile.status).toBe(404);
    fileMessages.add((unknownFile.body as { message: string }).message);

    const crossApplication = await revisionsKeyed(applicationBId, ownFileId, writerKey.key);
    expect(crossApplication.status).toBe(404);
    fileMessages.add((crossApplication.body as { message: string }).message);

    expect(applicationMessages.size).toBe(1);
    expect(Array.from(applicationMessages)[0]).toBe('Application not found.');
    expect(fileMessages.size).toBe(1);
    expect(Array.from(fileMessages)[0]).toBe('Application file not found.');
  });

  it('lets a read-only key list revisions but refuse the writes with one message', async () => {
    const path = 'src/reader-' + runId + '.ts';
    const written = await writeFileKeyed(applicationAId, path, 'const greeting = 1;', undefined, writerKey.key);
    expect(written.status).toBe(201);
    const fileId = (written.body as { id: string }).id;
    createdFileIds.push(fileId);

    const readable = await revisionsKeyed(applicationAId, fileId, readerKey.key);
    expect(readable.status).toBe(200);

    const refusedRestore = await restoreKeyed(applicationAId, fileId, 1, 1, readerKey.key);
    expect(refusedRestore.status).toBe(403);
    expect((refusedRestore.body as { message: string }).message).toBe('The API key does not grant the required scope.');

    const refusedDelete = await deleteKeyed(applicationAId, fileId, 1, readerKey.key);
    expect(refusedDelete.status).toBe(403);
    expect((refusedDelete.body as { message: string }).message).toBe('The API key does not grant the required scope.');
  });

  it('keeps revisions readable on archived applications but refuses keyed writes', async () => {
    const path = 'src/archived-' + runId + '.ts';
    const written = await writeFileKeyed(applicationBId, path, 'const greeting = 1;', undefined, writerKey.key);
    expect(written.status).toBe(201);
    const fileId = (written.body as { id: string }).id;
    createdFileIds.push(fileId);

    const archiveApplication = await api('POST', '/projects/' + mainProjectId + '/applications/' + applicationBId + '/archive', {}, hank.tokens.accessToken);
    expect(archiveApplication.status).toBe(201);

    const readable = await revisionsKeyed(applicationBId, fileId, readerKey.key);
    expect(readable.status).toBe(200);

    const refusedRestore = await restoreKeyed(applicationBId, fileId, 1, 1, writerKey.key);
    expect(refusedRestore.status).toBe(404);
    expect((refusedRestore.body as { message: string }).message).toBe('Application not found.');

    const refusedDelete = await deleteKeyed(applicationBId, fileId, 1, writerKey.key);
    expect(refusedDelete.status).toBe(404);
    expect((refusedDelete.body as { message: string }).message).toBe('Application not found.');
  });

  it('refuses revoked, expired, and unauthenticated callers uniformly', async () => {
    const path = 'src/lifecycle-' + runId + '.ts';
    const written = await writeFileKeyed(applicationAId, path, 'const greeting = 1;', undefined, writerKey.key);
    expect(written.status).toBe(201);
    const fileId = (written.body as { id: string }).id;
    createdFileIds.push(fileId);

    const revoke = await api('POST', '/organizations/' + organizationId + '/api-keys/' + revokedKey.id + '/revoke', {}, hank.tokens.accessToken);
    expect([200, 201]).toContain(revoke.status);

    const revokedDelete = await deleteKeyed(applicationAId, fileId, 1, revokedKey.key);
    expect(revokedDelete.status).toBe(401);
    expect((revokedDelete.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredDelete = await deleteKeyed(applicationAId, fileId, 1, shortLivedKey.key);
    expect(expiredDelete.status).toBe(401);
    expect((expiredDelete.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const unauthenticated = await deleteKeyed(applicationAId, fileId, 1);
    expect(unauthenticated.status).toBe(401);
    expect((unauthenticated.body as { message: string }).message).toBe('A valid GENESIS API key is required.');

    const row = await fileRow(fileId);
    expect(row!.isDeleted).toBe(false);
  });

  it('writes zero audit rows for the keyed file lifecycle', async () => {
    const path = 'src/audit-' + runId + '.ts';
    const written = await writeFileKeyed(applicationAId, path, 'const greeting = 1;', undefined, writerKey.key);
    expect(written.status).toBe(201);
    const fileId = (written.body as { id: string }).id;
    createdFileIds.push(fileId);
    const updated = await writeFileKeyed(applicationAId, path, 'const greeting = 2;', 1, writerKey.key);
    expect(updated.status).toBe(201);

    const before = await prisma.auditEvent.count({ where: { organizationId } });

    const history = await revisionsKeyed(applicationAId, fileId, readerKey.key);
    expect(history.status).toBe(200);
    const restored = await restoreKeyed(applicationAId, fileId, 1, 2, writerKey.key);
    expect(restored.status).toBe(201);
    const removed = await deleteKeyed(applicationAId, fileId, 3, writerKey.key);
    expect(removed.status).toBe(201);

    const after = await prisma.auditEvent.count({ where: { organizationId } });
    expect(after).toBe(before);
  });
});
