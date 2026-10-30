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
interface UserContext { email: string; password: string; tokens: TokenPair; userId: string; }
interface ApiResponse { status: number; body: Record<string, unknown>; }

/**
 * Data race suite: deployment intents, reference documents, conversations, and
 * file delete/restore hammered with simultaneous requests and double-taps over
 * the real HTTP surface against the real CI PostgreSQL. Every destructive
 * action pressed by two members at once must produce exactly one winner, a
 * clean refusal for the loser, and a consistent final state - never a 500.
 * No mocks.
 */
suite('GENESIS data races: deployments, references, conversations, file delete/restore (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let dana: UserContext;
  let erin: UserContext;
  let fred: UserContext;
  let projectId: string;
  let raceAppId: string;
  let deployableAppId: string;
  let blockedAppId: string;
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);
  const password = 'data-races-password-123';

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
    try { parsed = (await response.json()) as Record<string, unknown>; } catch { parsed = {}; }
    return { status: response.status, body: parsed };
  };

  const registerUser = async (name: string): Promise<UserContext> => {
    const email = 'genesis-data-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', { email, password, displayName: name });
    expect(response.status).toBe(201);
    const user = response.body.user as { id: string };
    createdUserIds.push(user.id);
    return { email, password, tokens: { accessToken: response.body.accessToken as string, refreshToken: response.body.refreshToken as string }, userId: user.id };
  };

  const sortedStatuses = (responses: ApiResponse[]) =>
    responses.map((response) => response.status).sort((a, b) => a - b);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({}).compile();
    await moduleRef.close();

    const { AppModule } = await import('../app.module');
    const testing = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = testing.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }));
    await app.init();
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer() as import('node:http').Server;
    const address = server.address() as { port: number };
    baseUrl = 'http://127.0.0.1:' + address.port + '/api/v1';
    prisma = app.get(PrismaService);
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

  it('prepares three members and honest deployment surfaces', async () => {
    dana = await registerUser('dana');
    erin = await registerUser('erin');
    fred = await registerUser('fred');

    const organizations = await api('GET', '/organizations', undefined, dana.tokens.accessToken);
    expect(organizations.status).toBe(200);
    const organizationId = (organizations.body as unknown as Array<{ id: string }>)[0].id;

    const addErin = await api('POST', '/organizations/' + organizationId + '/members', { email: erin.email, role: 'ADMIN' }, dana.tokens.accessToken);
    expect(addErin.status).toBe(201);
    const addFred = await api('POST', '/organizations/' + organizationId + '/members', { email: fred.email, role: 'VIEWER' }, dana.tokens.accessToken);
    expect(addFred.status).toBe(201);

    const workspaces = await api('GET', '/workspaces', undefined, dana.tokens.accessToken);
    expect(workspaces.status).toBe(200);
    const workspaceId = (workspaces.body as unknown as Array<{ id: string }>)[0].id;

    const project = await api('POST', '/workspaces/' + workspaceId + '/projects', { name: 'Data Races Project' }, dana.tokens.accessToken);
    expect(project.status).toBe(201);
    projectId = (project.body as { id: string }).id;

    const raceApp = await api('POST', '/projects/' + projectId + '/applications', { name: 'Race App' }, dana.tokens.accessToken);
    expect(raceApp.status).toBe(201);
    raceAppId = (raceApp.body as { id: string }).id;

    const deployable = await api('POST', '/projects/' + projectId + '/applications', { name: 'Deployable App' }, dana.tokens.accessToken);
    expect(deployable.status).toBe(201);
    deployableAppId = (deployable.body as { id: string }).id;

    const blocked = await api('POST', '/projects/' + projectId + '/applications', { name: 'Blocked App' }, dana.tokens.accessToken);
    expect(blocked.status).toBe(201);
    blockedAppId = (blocked.body as { id: string }).id;

    const page = await api('POST', '/applications/' + deployableAppId + '/files', { path: 'index.html', content: '<!doctype html><html><body><h1>Races</h1></body></html>' }, dana.tokens.accessToken);
    expect(page.status).toBe(201);

    const verified = await api('POST', '/applications/' + deployableAppId + '/verifications', {}, dana.tokens.accessToken);
    expect(verified.status).toBe(201);
    const runs = verified.body as unknown as Array<{ status: string }>;
    expect(runs.length).toBe(3);
    runs.forEach((run) => expect(['PASSED', 'SKIPPED']).toContain(run.status));

    const ready = await api('GET', '/applications/' + deployableAppId + '/deployments/readiness', undefined, dana.tokens.accessToken);
    expect(ready.status).toBe(200);
    expect((ready.body as { verdict: string }).verdict).toBe('READY');

    const blockedReadiness = await api('GET', '/applications/' + blockedAppId + '/deployments/readiness', undefined, dana.tokens.accessToken);
    expect(blockedReadiness.status).toBe(200);
    expect((blockedReadiness.body as { verdict: string }).verdict).toBe('BLOCKED');
  });

  it('records two independent honest deployment intents when two admins press create simultaneously', async () => {
    const raced = await Promise.all([
      api('POST', '/applications/' + deployableAppId + '/deployments', { environment: 'PREVIEW' }, dana.tokens.accessToken),
      api('POST', '/applications/' + deployableAppId + '/deployments', { environment: 'STAGING', target: 'staging-slot' }, erin.tokens.accessToken),
    ]);
    expect(raced.every((response) => response.status === 201)).toBe(true);
    const ids = new Set(raced.map((response) => (response.body as { id: string }).id));
    expect(ids.size).toBe(2);
    raced.forEach((response) => {
      const record = response.body as {
        status: string;
        metadata: { readiness: { verdict: string }; adapter: string; executionNote: string };
      };
      expect(['READY', 'PENDING']).toContain(record.status);
      expect(record.metadata.readiness.verdict).toBe('READY');
      expect(record.metadata.adapter).toBe('none-configured');
      expect(record.metadata.executionNote).toContain('does not claim execution');
    });

    const listed = await api('GET', '/applications/' + deployableAppId + '/deployments', undefined, dana.tokens.accessToken);
    expect(listed.status).toBe(200);
    expect((listed.body as unknown as Array<{ id: string }>).length).toBe(2);

    // A read-only member can read intents but never create them; unknown and
    // non-application ids get the same uniform 404.
    const viewerList = await api('GET', '/applications/' + deployableAppId + '/deployments', undefined, fred.tokens.accessToken);
    expect(viewerList.status).toBe(200);
    const viewerCreate = await api('POST', '/applications/' + deployableAppId + '/deployments', { environment: 'PREVIEW' }, fred.tokens.accessToken);
    expect(viewerCreate.status).toBe(404);
    const unknownApp = await api('POST', '/applications/nonexistent-application/deployments', { environment: 'PREVIEW' }, dana.tokens.accessToken);
    expect(unknownApp.status).toBe(404);
    const foreignApp = await api('POST', '/applications/' + projectId + '/deployments', { environment: 'PREVIEW' }, dana.tokens.accessToken);
    expect(foreignApp.status).toBe(404);
    const unknownDeployment = await api('GET', '/applications/' + deployableAppId + '/deployments/nonexistent-deployment', undefined, dana.tokens.accessToken);
    expect(unknownDeployment.status).toBe(404);
  });

  it('refuses blocked deployments identically on a double-tap', async () => {
    const raced = await Promise.all([
      api('POST', '/applications/' + blockedAppId + '/deployments', { environment: 'PRODUCTION' }, dana.tokens.accessToken),
      api('POST', '/applications/' + blockedAppId + '/deployments', { environment: 'PRODUCTION' }, erin.tokens.accessToken),
    ]);
    expect(raced.map((response) => response.status)).toEqual([400, 400]);
    raced.forEach((response) => {
      const body = response.body as { readiness?: { verdict: string } };
      expect(body.readiness?.verdict).toBe('BLOCKED');
    });
    const rows = await prisma.deployment.count({ where: { applicationId: blockedAppId } });
    expect(rows).toBe(0);
  });

  it('deletes a file exactly once on a double-tap and records an honest tombstone', async () => {
    const write = await api('POST', '/applications/' + raceAppId + '/files', { path: 'race/delete-tap.ts', content: 'export const gone = 1;', language: 'typescript' }, dana.tokens.accessToken);
    expect(write.status).toBe(201);
    const fileId = (write.body as { id: string }).id;

    const first = await api('DELETE', '/applications/' + raceAppId + '/files/' + fileId + '/revision/1', undefined, dana.tokens.accessToken);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ deleted: true, revision: 2 });

    // The double-tap finds the file already deleted: a clean 404, never a 500.
    const second = await api('DELETE', '/applications/' + raceAppId + '/files/' + fileId + '/revision/1', undefined, erin.tokens.accessToken);
    expect(second.status).toBe(404);

    const read = await api('GET', '/applications/' + raceAppId + '/files/' + fileId, undefined, dana.tokens.accessToken);
    expect(read.status).toBe(404);

    const list = await api('GET', '/applications/' + raceAppId + '/files', undefined, dana.tokens.accessToken);
    expect((list.body as unknown as Array<{ id: string }>).some((file) => file.id === fileId)).toBe(false);

    // The immutable history keeps exactly one tombstone revision 2.
    const tombstones = await prisma.fileRevision.count({ where: { fileId, revision: 2, isDeleted: true } });
    expect(tombstones).toBe(1);
  });

  it('resolves a delete racing a write with exactly one winner and a clean retryable 409', async () => {
    const write1 = await api('POST', '/applications/' + raceAppId + '/files', { path: 'race/delete-vs-write.ts', content: 'export const v1 = 1;', language: 'typescript' }, dana.tokens.accessToken);
    expect(write1.status).toBe(201);
    const fileId = (write1.body as { id: string }).id;
    const write2 = await api('POST', '/applications/' + raceAppId + '/files', { path: 'race/delete-vs-write.ts', content: 'export const v2 = 2;', language: 'typescript', expectedRevision: 1 }, dana.tokens.accessToken);
    expect(write2.status).toBe(201);

    const del = () => api('DELETE', '/applications/' + raceAppId + '/files/' + fileId + '/revision/2', undefined, dana.tokens.accessToken);
    const put = () => api('POST', '/applications/' + raceAppId + '/files', { path: 'race/delete-vs-write.ts', content: 'export const v3 = 3;', language: 'typescript', expectedRevision: 2 }, erin.tokens.accessToken);
    const raced = await Promise.all([del(), put()]);
    // The winner is whichever lands first: the delete ends 200, the write 201.
    const statuses = sortedStatuses(raced);
    expect(statuses).toEqual(raced[0].status === 200 ? [200, 409] : [201, 409]);

    const deleteWon = raced[0].status === 200;
    const read = await api('GET', '/applications/' + raceAppId + '/files/' + fileId, undefined, dana.tokens.accessToken);
    if (deleteWon) {
      expect(read.status).toBe(404);
    } else {
      expect(read.status).toBe(200);
      expect((read.body as { content: string }).content).toBe('export const v3 = 3;');
    }

    // Exactly one immutable revision 3 exists, consistent with the winner.
    const rev3 = await prisma.fileRevision.count({ where: { fileId, revision: 3 } });
    expect(rev3).toBe(1);
    const row = await prisma.applicationFile.findUnique({ where: { id: fileId } });
    expect(row?.revision).toBe(3);
    expect(row?.isDeleted).toBe(deleteWon);
  });

  it('resolves a restore racing a delete with exactly one winner and a consistent chain', async () => {
    const write1 = await api('POST', '/applications/' + raceAppId + '/files', { path: 'race/restore-vs-delete.ts', content: 'export const v1 = 1;', language: 'typescript' }, dana.tokens.accessToken);
    expect(write1.status).toBe(201);
    const fileId = (write1.body as { id: string }).id;
    const write2 = await api('POST', '/applications/' + raceAppId + '/files', { path: 'race/restore-vs-delete.ts', content: 'export const v2 = 2;', language: 'typescript', expectedRevision: 1 }, dana.tokens.accessToken);
    expect(write2.status).toBe(201);

    const restore = () => api('POST', '/applications/' + raceAppId + '/files/' + fileId + '/restore/1', { expectedCurrentRevision: 2 }, dana.tokens.accessToken);
    const del = () => api('DELETE', '/applications/' + raceAppId + '/files/' + fileId + '/revision/2', undefined, erin.tokens.accessToken);
    const raced = await Promise.all([restore(), del()]);
    const statuses = sortedStatuses(raced);
    expect(statuses).toEqual(raced[0].status === 201 ? [201, 409] : [200, 409]);

    const restoreWon = raced[0].status === 201;
    const read = await api('GET', '/applications/' + raceAppId + '/files/' + fileId, undefined, dana.tokens.accessToken);
    if (restoreWon) {
      expect(read.status).toBe(200);
      expect((read.body as { content: string }).content).toBe('export const v1 = 1;');
    } else {
      expect(read.status).toBe(404);
    }

    const rev3 = await prisma.fileRevision.count({ where: { fileId, revision: 3 } });
    expect(rev3).toBe(1);
    const row = await prisma.applicationFile.findUnique({ where: { id: fileId } });
    expect(row?.revision).toBe(3);
    expect(row?.isDeleted).toBe(!restoreWon);
  });

  it('applies exactly one restore when the same revision restore is double-tapped', async () => {
    const write1 = await api('POST', '/applications/' + raceAppId + '/files', { path: 'race/restore-tap.ts', content: 'export const v1 = 1;', language: 'typescript' }, dana.tokens.accessToken);
    expect(write1.status).toBe(201);
    const fileId = (write1.body as { id: string }).id;
    const write2 = await api('POST', '/applications/' + raceAppId + '/files', { path: 'race/restore-tap.ts', content: 'export const v2 = 2;', language: 'typescript', expectedRevision: 1 }, dana.tokens.accessToken);
    expect(write2.status).toBe(201);

    const restore = () => api('POST', '/applications/' + raceAppId + '/files/' + fileId + '/restore/1', { expectedCurrentRevision: 2 }, dana.tokens.accessToken);
    const raced = await Promise.all([restore(), restore()]);
    expect(sortedStatuses(raced)).toEqual([201, 409]);

    const read = await api('GET', '/applications/' + raceAppId + '/files/' + fileId, undefined, dana.tokens.accessToken);
    expect(read.status).toBe(200);
    expect((read.body as { content: string; revision: number }).content).toBe('export const v1 = 1;');
    expect((read.body as { content: string; revision: number }).revision).toBe(3);

    const rev3 = await prisma.fileRevision.count({ where: { fileId, revision: 3 } });
    expect(rev3).toBe(1);
    const total = await prisma.fileRevision.count({ where: { fileId } });
    expect(total).toBe(3);
  });

  it('resurrects a deleted file through an honest expectedRevision write', async () => {
    const write = await api('POST', '/applications/' + raceAppId + '/files', { path: 'race/resurrect.ts', content: 'export const v1 = 1;', language: 'typescript' }, dana.tokens.accessToken);
    expect(write.status).toBe(201);
    const fileId = (write.body as { id: string }).id;

    const deleted = await api('DELETE', '/applications/' + raceAppId + '/files/' + fileId + '/revision/1', undefined, dana.tokens.accessToken);
    expect(deleted.status).toBe(200);
    const readGone = await api('GET', '/applications/' + raceAppId + '/files/' + fileId, undefined, dana.tokens.accessToken);
    expect(readGone.status).toBe(404);

    // A write with the tombstone revision brings the file back honestly.
    const revive = await api('POST', '/applications/' + raceAppId + '/files', { path: 'race/resurrect.ts', content: 'export const back = true;', language: 'typescript', expectedRevision: 2 }, dana.tokens.accessToken);
    expect(revive.status).toBe(201);
    expect((revive.body as { revision: number }).revision).toBe(3);

    const read = await api('GET', '/applications/' + raceAppId + '/files/' + fileId, undefined, dana.tokens.accessToken);
    expect(read.status).toBe(200);
    expect((read.body as { content: string }).content).toBe('export const back = true;');

    const total = await prisma.fileRevision.count({ where: { fileId } });
    expect(total).toBe(3);
  });

  it('deletes a reference exactly once on a double-tap', async () => {
    const created = await api('POST', '/applications/' + raceAppId + '/references', { title: 'Tap spec', kind: 'SPEC', content: 'The page must load in under two seconds.' }, dana.tokens.accessToken);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'STORED', kind: 'SPEC' });
    const referenceId = (created.body as { id: string }).id;

    const first = await api('DELETE', '/applications/' + raceAppId + '/references/' + referenceId, undefined, dana.tokens.accessToken);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ deleted: true });

    const second = await api('DELETE', '/applications/' + raceAppId + '/references/' + referenceId, undefined, erin.tokens.accessToken);
    expect(second.status).toBe(404);

    const gone = await api('GET', '/applications/' + raceAppId + '/references/' + referenceId, undefined, dana.tokens.accessToken);
    expect(gone.status).toBe(404);
  });

  it('lets two members racing a reference deletion get exactly one 200 and one clean 404', async () => {
    const created = await api('POST', '/applications/' + raceAppId + '/references', { title: 'Race notes', kind: 'NOTES', content: 'Notes used by the reference deletion race.' }, dana.tokens.accessToken);
    expect(created.status).toBe(201);
    const referenceId = (created.body as { id: string }).id;

    const raced = await Promise.all([
      api('DELETE', '/applications/' + raceAppId + '/references/' + referenceId, undefined, dana.tokens.accessToken),
      api('DELETE', '/applications/' + raceAppId + '/references/' + referenceId, undefined, erin.tokens.accessToken),
    ]);
    expect(sortedStatuses(raced)).toEqual([200, 404]);

    // Exactly one audit row records the deletion - never two, never zero.
    const audits = await prisma.auditEvent.count({ where: { action: 'application.reference.delete', resourceId: referenceId } });
    expect(audits).toBe(1);
  });

  it('resolves a reference deletion racing an extraction without a 500', async () => {
    const created = await api('POST', '/applications/' + raceAppId + '/references', { title: 'Delete-extract spec', kind: 'SPEC', content: 'A specification deleted while extraction is running.' }, dana.tokens.accessToken);
    const referenceId = (created.body as { id: string }).id;

    const del = () => api('DELETE', '/applications/' + raceAppId + '/references/' + referenceId, undefined, dana.tokens.accessToken);
    const extract = () => api('POST', '/applications/' + raceAppId + '/references/' + referenceId + '/extract', {}, erin.tokens.accessToken);
    const raced = await Promise.all([del(), extract()]);
    // The delete always succeeds; the extraction either honestly failed first
    // (502/503 with EXTRACTION_FAILED recorded) or found the reference gone (404).
    expect(raced[0].status).toBe(200);
    expect([404, 502, 503]).toContain(raced[1].status);

    const gone = await api('GET', '/applications/' + raceAppId + '/references/' + referenceId, undefined, dana.tokens.accessToken);
    expect(gone.status).toBe(404);
  });

  it('runs a double-tapped extraction as independent honest attempts without a 500', async () => {
    const created = await api('POST', '/applications/' + raceAppId + '/references', { title: 'Extract race spec', kind: 'SPEC', content: 'A specification extracted twice at the same time.' }, dana.tokens.accessToken);
    const referenceId = (created.body as { id: string }).id;

    const raced = await Promise.all([
      api('POST', '/applications/' + raceAppId + '/references/' + referenceId + '/extract', {}, dana.tokens.accessToken),
      api('POST', '/applications/' + raceAppId + '/references/' + referenceId + '/extract', {}, erin.tokens.accessToken),
    ]);
    raced.forEach((response) => expect([200, 404, 502, 503]).toContain(response.status));

    const fetched = await api('GET', '/applications/' + raceAppId + '/references/' + referenceId, undefined, dana.tokens.accessToken);
    expect(fetched.status).toBe(200);
    const reference = fetched.body as { status: string; extractionError?: unknown };
    if (raced.every((response) => response.status !== 200)) {
      // No provider is configured: both attempts failed honestly and the
      // reference records EXTRACTION_FAILED with the real error, retriable.
      expect(reference.status).toBe('EXTRACTION_FAILED');
      expect(typeof reference.extractionError).toBe('string');
    } else {
      expect(reference.status).toBe('EXTRACTED');
    }
  });

  it('stores simultaneous messages from two members and refuses read-only posters', async () => {
    const conversation = await api('POST', '/applications/' + raceAppId + '/conversations', { title: 'Races' }, dana.tokens.accessToken);
    expect(conversation.status).toBe(201);
    const conversationId = (conversation.body as { id: string }).id;

    const raced = await Promise.all([
      api('POST', '/conversations/' + conversationId + '/messages', { content: 'First simultaneous note.' }, dana.tokens.accessToken),
      api('POST', '/conversations/' + conversationId + '/messages', { content: 'Second simultaneous note.' }, erin.tokens.accessToken),
    ]);
    expect(raced.every((response) => response.status === 201)).toBe(true);
    const ids = new Set(raced.map((response) => (response.body as { id: string }).id));
    expect(ids.size).toBe(2);

    const listed = await api('GET', '/conversations/' + conversationId + '/messages', undefined, fred.tokens.accessToken);
    expect(listed.status).toBe(200);
    const messages = listed.body as unknown as Array<{ content: string }>;
    expect(messages.length).toBe(2);
    expect(new Set(messages.map((message) => message.content)).size).toBe(2);

    // A read-only member can read but never post; unknown conversations 404.
    const viewerPost = await api('POST', '/conversations/' + conversationId + '/messages', { content: 'Viewers cannot post.' }, fred.tokens.accessToken);
    expect(viewerPost.status).toBe(404);
    const unknownConversation = await api('POST', '/conversations/nonexistent-conversation/messages', { content: 'Nope.' }, dana.tokens.accessToken);
    expect(unknownConversation.status).toBe(404);
  });

  it('archives a conversation cleanly, races the archive against a message, and blocks posts afterwards', async () => {
    const conversation = await api('POST', '/applications/' + raceAppId + '/conversations', { title: 'Archive race' }, dana.tokens.accessToken);
    expect(conversation.status).toBe(201);
    const conversationId = (conversation.body as { id: string }).id;

    const raced = await Promise.all([
      api('PATCH', '/conversations/' + conversationId + '/archive', undefined, dana.tokens.accessToken),
      api('POST', '/conversations/' + conversationId + '/messages', { content: 'Racing the archive.' }, erin.tokens.accessToken),
    ]);
    expect(raced[0].status).toBe(200);
    expect((raced[0].body as { archivedAt: string }).archivedAt).toBeDefined();
    expect([201, 409]).toContain(raced[1].status);

    const listed = await api('GET', '/conversations/' + conversationId + '/messages', undefined, dana.tokens.accessToken);
    expect(listed.status).toBe(200);
    expect((listed.body as unknown as Array<{ id: string }>).length).toBeLessThanOrEqual(1);

    // Posting after the archive is an honest 409; the archive replay is a no-op.
    const after = await api('POST', '/conversations/' + conversationId + '/messages', { content: 'Too late.' }, erin.tokens.accessToken);
    expect(after.status).toBe(409);
    const replay = await api('PATCH', '/conversations/' + conversationId + '/archive', undefined, erin.tokens.accessToken);
    expect(replay.status).toBe(200);
    expect((replay.body as { archivedAt: string }).archivedAt).toBeDefined();

    // Messages remain readable after archiving, even for read-only members.
    const readable = await api('GET', '/conversations/' + conversationId + '/messages', undefined, fred.tokens.accessToken);
    expect(readable.status).toBe(200);
  });

  it('creates independent conversations on a double-tap', async () => {
    const before = await api('GET', '/applications/' + raceAppId + '/conversations', undefined, dana.tokens.accessToken);
    expect(before.status).toBe(200);
    const beforeCount = (before.body as unknown as Array<{ id: string }>).length;

    const raced = await Promise.all([
      api('POST', '/applications/' + raceAppId + '/conversations', { title: 'Twin' }, dana.tokens.accessToken),
      api('POST', '/applications/' + raceAppId + '/conversations', { title: 'Twin' }, erin.tokens.accessToken),
    ]);
    expect(raced.every((response) => response.status === 201)).toBe(true);
    const ids = new Set(raced.map((response) => (response.body as { id: string }).id));
    expect(ids.size).toBe(2);

    const after = await api('GET', '/applications/' + raceAppId + '/conversations', undefined, dana.tokens.accessToken);
    expect((after.body as unknown as Array<{ id: string }>).length).toBe(beforeCount + 2);
  });
});
