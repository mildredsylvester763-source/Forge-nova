import { ConflictException, INestApplication, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JobStatus, Prisma, WorkGraphStatus } from '@prisma/client';
import { JobQueueService } from '../execution/job-queue.service';
import { PrismaService } from '../database/prisma.service';
import { WorkGraphPlannerService } from '../work-graphs/work-graph-planner.service';

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
 * Operation race suite: the durable job queue, checkpoints, verification runs,
 * and work-graph planning leases hammered with simultaneous requests and
 * double-taps. HTTP hammers the real app; worker-side semantics (claim,
 * heartbeat, complete, fail, acknowledge-cancellation) are exercised through
 * the REAL services against the real database - the exact code a production
 * worker would call. Every test asserts exactly-one-winner behavior, clean
 * refusals for losers, and a consistent final state. No mocks.
 */
suite('GENESIS job, checkpoint, and planning-lease races (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let jobs: JobQueueService;
  let planner: WorkGraphPlannerService;
  let prisma: PrismaService;
  let hans: UserContext;
  let ines: UserContext;
  let greta: UserContext;
  let organizationId: string;
  let workspaceId: string;
  let projectId: string;
  let applicationId: string;
  let baseFileId: string;
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);
  const password = 'operation-races-password-123';
  const basePath = 'base.ts';
  const v1Content = 'export const base = "v1";';
  const v4Content = 'export const base = "v4";';
  const v5Content = 'export const base = "v5";';

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
    const email = 'genesis-ops-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', { email, password, displayName: name });
    expect(response.status).toBe(201);
    const user = response.body.user as { id: string };
    createdUserIds.push(user.id);
    return { email, password, tokens: { accessToken: response.body.accessToken as string, refreshToken: response.body.refreshToken as string }, userId: user.id };
  };

  const sortedStatuses = (responses: ApiResponse[]) =>
    responses.map((response) => response.status).sort((a, b) => a - b);

  // The list endpoint omits content by design; the read endpoint returns it.
  const readBaseFile = async (token: string) => {
    const read = await api('GET', '/applications/' + applicationId + '/files/' + baseFileId, undefined, token);
    expect(read.status).toBe(200);
    return read.body as unknown as { id: string; path: string; content: string; revision: number };
  };

  const revisionRowCount = async () =>
    prisma.fileRevision.count({ where: { fileId: baseFileId } });

  // Defensive: if a worker claim ever lands on a job this suite did not create,
  // undo the claim so no other suite is disturbed.
  const revertForeignClaim = async (jobId: string) => {
    await prisma.workJob.update({
      where: { id: jobId },
      data: {
        status: JobStatus.QUEUED,
        lockedBy: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        startedAt: null,
        attemptCount: { decrement: 1 },
      },
    });
  };

  // claimNext is FIFO by createdAt across the whole table; backdating our own
  // job makes every claim deterministic even in the shared CI queue.
  const backdateJob = async (jobId: string) => {
    await prisma.workJob.update({
      where: { id: jobId },
      data: { createdAt: new Date(Date.now() - 3_600_000) },
    });
  };

  const planGraph = async (title: string, token: string) => {
    const graph = await api('POST', '/applications/' + applicationId + '/work-graphs', { title, sourcePrompt: 'Build a small reporting service with an HTTP endpoint.' }, token);
    expect(graph.status).toBe(201);
    const graphId = (graph.body as { id: string }).id;
    const plan = await api('POST', '/work-graphs/' + graphId + '/plan', {}, token);
    expect(plan.status).toBe(201);
    return { graphId, jobId: (plan.body as { jobId: string }).jobId };
  };

  const simulateLease = async (jobId: string, workerId: string, leaseExpired: boolean, attemptCount: number) => {
    await prisma.workJob.update({
      where: { id: jobId },
      data: {
        status: JobStatus.RUNNING,
        lockedBy: workerId,
        attemptCount,
        startedAt: new Date(),
        heartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + (leaseExpired ? -60_000 : 120_000)),
        cancelRequestedAt: null,
      },
    });
  };

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
    jobs = app.get(JobQueueService);
    planner = app.get(WorkGraphPlannerService);
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

  it('prepares three members, a writable application, and a source file', async () => {
    hans = await registerUser('hans');
    ines = await registerUser('ines');
    greta = await registerUser('greta');

    const organizations = await api('GET', '/organizations', undefined, hans.tokens.accessToken);
    expect(organizations.status).toBe(200);
    organizationId = (organizations.body as unknown as Array<{ id: string }>)[0].id;

    const addInes = await api('POST', '/organizations/' + organizationId + '/members', { email: ines.email, role: 'ADMIN' }, hans.tokens.accessToken);
    expect(addInes.status).toBe(201);
    const addGreta = await api('POST', '/organizations/' + organizationId + '/members', { email: greta.email, role: 'VIEWER' }, hans.tokens.accessToken);
    expect(addGreta.status).toBe(201);

    const workspaces = await api('GET', '/workspaces', undefined, hans.tokens.accessToken);
    expect(workspaces.status).toBe(200);
    workspaceId = (workspaces.body as unknown as Array<{ id: string }>)[0].id;

    const project = await api('POST', '/workspaces/' + workspaceId + '/projects', { name: 'Operation Races Project' }, hans.tokens.accessToken);
    expect(project.status).toBe(201);
    projectId = (project.body as { id: string }).id;

    const application = await api('POST', '/projects/' + projectId + '/applications', { name: 'Races App' }, hans.tokens.accessToken);
    expect(application.status).toBe(201);
    applicationId = (application.body as { id: string }).id;

    const file = await api('POST', '/applications/' + applicationId + '/files', { path: basePath, content: v1Content, language: 'typescript' }, hans.tokens.accessToken);
    expect(file.status).toBe(201);
    const stored = await prisma.applicationFile.findFirst({ where: { applicationId, path: basePath } });
    expect(stored).not.toBeNull();
    baseFileId = stored!.id;
  });

  it('queues exactly one planning job when two write members press plan simultaneously', async () => {
    const graph = await api('POST', '/applications/' + applicationId + '/work-graphs', { title: 'Plan Race Graph', sourcePrompt: 'Build a small reporting service.' }, hans.tokens.accessToken);
    expect(graph.status).toBe(201);
    const graphId = (graph.body as { id: string }).id;

    const raced = await Promise.all([
      api('POST', '/work-graphs/' + graphId + '/plan', {}, hans.tokens.accessToken),
      api('POST', '/work-graphs/' + graphId + '/plan', {}, ines.tokens.accessToken),
    ]);
    expect(raced.every((response) => response.status === 201)).toBe(true);

    const jobIds = raced.map((response) => (response.body as { jobId: string }).jobId);
    expect(jobIds[0]).toBe(jobIds[1]);

    const rows = await prisma.workJob.count({
      where: { applicationId, input: { path: ['graphId'], equals: graphId } },
    });
    expect(rows).toBe(1);

    const job = await prisma.workJob.findFirst({ where: { applicationId, input: { path: ['graphId'], equals: graphId } } });
    expect(job?.status).toBe(JobStatus.QUEUED);
  });

  it('cancels a queued job cleanly, replays the cancel as a no-op, and requeues instead of duplicating', async () => {
    const graph = await api('POST', '/applications/' + applicationId + '/work-graphs', { title: 'Cancel Replay Graph', sourcePrompt: 'Build a small scheduler service.' }, hans.tokens.accessToken);
    const graphId = (graph.body as { id: string }).id;
    const plan = await api('POST', '/work-graphs/' + graphId + '/plan', {}, hans.tokens.accessToken);
    expect(plan.status).toBe(201);
    const jobId = (plan.body as { jobId: string }).jobId;

    const cancel = await api('POST', '/applications/' + applicationId + '/jobs/' + jobId + '/cancel', {}, hans.tokens.accessToken);
    expect(cancel.status).toBe(201);
    expect(cancel.body.status).toBe('CANCELLED');

    const status = await api('GET', '/applications/' + applicationId + '/jobs/' + jobId, undefined, hans.tokens.accessToken);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('CANCELLED');

    // Double-tap: cancelling an already-cancelled job is an honest no-op.
    const replay = await api('POST', '/applications/' + applicationId + '/jobs/' + jobId + '/cancel', {}, hans.tokens.accessToken);
    expect(replay.status).toBe(201);
    expect(replay.body.status).toBe('CANCELLED');
    expect(replay.body.cancellationRequested).toBe(false);

    // Re-planning the same graph version requeues the SAME job (idempotency key reset), never a duplicate.
    const replan = await api('POST', '/work-graphs/' + graphId + '/plan', {}, hans.tokens.accessToken);
    expect(replan.status).toBe(201);
    expect((replan.body as { jobId: string }).jobId).toBe(jobId);
    expect(replan.body.status).toBe('QUEUED');
    const rows = await prisma.workJob.count({
      where: { applicationId, input: { path: ['graphId'], equals: graphId } },
    });
    expect(rows).toBe(1);
  });

  it('cancels a queued job exactly once when two admins press cancel at the same time', async () => {
    const graph = await api('POST', '/applications/' + applicationId + '/work-graphs', { title: 'Cancel Race Graph', sourcePrompt: 'Build a small queue service.' }, hans.tokens.accessToken);
    const graphId = (graph.body as { id: string }).id;
    const plan = await api('POST', '/work-graphs/' + graphId + '/plan', {}, hans.tokens.accessToken);
    const jobId = (plan.body as { jobId: string }).jobId;

    const raced = await Promise.all([
      api('POST', '/applications/' + applicationId + '/jobs/' + jobId + '/cancel', {}, hans.tokens.accessToken),
      api('POST', '/applications/' + applicationId + '/jobs/' + jobId + '/cancel', {}, ines.tokens.accessToken),
    ]);
    expect(raced.every((response) => response.status === 201)).toBe(true);
    raced.forEach((response) => expect(response.body.status).toBe('CANCELLED'));

    const row = await prisma.workJob.findUnique({ where: { id: jobId } });
    expect(row?.status).toBe(JobStatus.CANCELLED);
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.lockedBy).toBeNull();

    // Uniform refusals: a read-only member, an unknown job, and a foreign application all get the same 404.
    const viewerCancel = await api('POST', '/applications/' + applicationId + '/jobs/' + jobId + '/cancel', {}, greta.tokens.accessToken);
    expect(viewerCancel.status).toBe(404);
    const unknownJob = await api('POST', '/applications/' + applicationId + '/jobs/does-not-exist/cancel', {}, hans.tokens.accessToken);
    expect(unknownJob.status).toBe(404);
    const foreignApp = await api('POST', '/applications/' + workspaceId + '/jobs/' + jobId + '/cancel', {}, hans.tokens.accessToken);
    expect(foreignApp.status).toBe(404);

    // A viewer may still READ the job.
    const view = await api('GET', '/applications/' + applicationId + '/jobs/' + jobId, undefined, greta.tokens.accessToken);
    expect(view.status).toBe(200);
    expect(view.body.status).toBe('CANCELLED');
  });

  it('resolves cancel-versus-completion races with exactly one clean ending', async () => {
    const graph = await api('POST', '/applications/' + applicationId + '/work-graphs', { title: 'Completion Race Graph', sourcePrompt: 'Build a small cache service.' }, hans.tokens.accessToken);
    const graphId = (graph.body as { id: string }).id;
    const plan = await api('POST', '/work-graphs/' + graphId + '/plan', {}, hans.tokens.accessToken);
    const jobId = (plan.body as { jobId: string }).jobId;
    await simulateLease(jobId, 'racer-worker', false, 1);

    const [cancelSettled, completeSettled] = await Promise.allSettled([
      api('POST', '/applications/' + applicationId + '/jobs/' + jobId + '/cancel', {}, hans.tokens.accessToken),
      jobs.complete(jobId, 'racer-worker', { outcome: 'race-tested' } as Prisma.InputJsonValue),
    ]);
    if (cancelSettled.status !== 'fulfilled') throw new Error('The cancel request did not settle.');
    const cancel = cancelSettled.value;
    expect(cancel.status).toBe(201);

    if (completeSettled.status === 'fulfilled') {
      // Completion won: the cancel request honestly reports the job is already done.
      expect(cancel.body.status).toBe('SUCCEEDED');
      expect(cancel.body.cancellationRequested).toBe(false);
      const row = await prisma.workJob.findUnique({ where: { id: jobId } });
      expect(row?.status).toBe(JobStatus.SUCCEEDED);
      expect(row?.lockedBy).toBeNull();
    } else {
      // Cancellation won: the worker's completion is refused, and the worker must acknowledge.
      expect(completeSettled.reason).toBeInstanceOf(ConflictException);
      expect(cancel.body.cancellationRequested).toBe(true);
      const ack = await jobs.acknowledgeCancellation(jobId, 'racer-worker');
      expect(ack.status).toBe('CANCELLED');
      const row = await prisma.workJob.findUnique({ where: { id: jobId } });
      expect(row?.status).toBe(JobStatus.CANCELLED);
      expect(row?.lockedBy).toBeNull();
    }
  });

  it('refuses a zombie worker whose lease expired after another worker took over', async () => {
    const { jobId } = await planGraph('Zombie Graph', hans.tokens.accessToken);
    await simulateLease(jobId, 'zombie-a', true, 1);
    await backdateJob(jobId);

    const claimed = await jobs.claimNext('worker-b');
    expect(claimed).not.toBeNull();
    if (claimed && claimed.id !== jobId) {
      await revertForeignClaim(claimed.id);
      const second = await jobs.claimNext('worker-b');
      expect(second?.id).toBe(jobId);
    }
    const row1 = await prisma.workJob.findUnique({ where: { id: jobId } });
    expect(row1?.lockedBy).toBe('worker-b');
    expect(row1?.attemptCount).toBe(2);

    // The zombie worker cannot complete, heartbeat, or fail the stolen job.
    await expect(jobs.complete(jobId, 'zombie-a', { zombie: true } as Prisma.InputJsonValue)).rejects.toThrow(ConflictException);
    await expect(jobs.heartbeat(jobId, 'zombie-a')).rejects.toThrow(ConflictException);
    await expect(jobs.fail(jobId, 'zombie-a', 'ZOMBIE', 'The zombie worker reported a failure.', false)).rejects.toThrow(ConflictException);

    // The new owner holds a live lease and finishes cleanly.
    const beat = await jobs.heartbeat(jobId, 'worker-b');
    expect(beat.cancellationRequested).toBe(false);
    await jobs.complete(jobId, 'worker-b', { outcome: 'recovered-by-worker-b' } as Prisma.InputJsonValue);
    const row2 = await prisma.workJob.findUnique({ where: { id: jobId } });
    expect(row2?.status).toBe(JobStatus.SUCCEEDED);

    const status = await api('GET', '/applications/' + applicationId + '/jobs/' + jobId, undefined, hans.tokens.accessToken);
    expect(status.body.status).toBe('SUCCEEDED');
  });

  it('never lets two workers claim the same job', async () => {
    const { jobId } = await planGraph('Claim Race Graph', hans.tokens.accessToken);
    await backdateJob(jobId);

    const [claimA, claimB] = await Promise.all([
      jobs.claimNext('w-left'),
      jobs.claimNext('w-right'),
    ]);
    for (const claim of [claimA, claimB]) {
      if (claim && claim.id !== jobId) await revertForeignClaim(claim.id);
    }
    const ours = [claimA, claimB].filter((claim) => claim && claim.id === jobId);
    expect(ours.length).toBe(1);

    const row = await prisma.workJob.findUnique({ where: { id: jobId } });
    expect(row?.status).toBe(JobStatus.RUNNING);
    expect(['w-left', 'w-right']).toContain(row?.lockedBy);
    expect(row?.attemptCount).toBe(1);

    await jobs.complete(jobId, row!.lockedBy as string, { outcome: 'claim-race-winner' } as Prisma.InputJsonValue);
    expect((await prisma.workJob.findUnique({ where: { id: jobId } }))?.status).toBe(JobStatus.SUCCEEDED);
  });

  it('keeps cancel-versus-claim races on an expired lease consistent', async () => {
    const { jobId } = await planGraph('Expired Lease Graph', hans.tokens.accessToken);
    await simulateLease(jobId, 'ghost-worker', true, 1);
    await backdateJob(jobId);

    const [claimSettled, cancelSettled] = await Promise.allSettled([
      jobs.claimNext('rescuer'),
      api('POST', '/applications/' + applicationId + '/jobs/' + jobId + '/cancel', {}, hans.tokens.accessToken),
    ]);
    if (cancelSettled.status !== 'fulfilled') throw new Error('The cancel request did not settle.');
    const cancelResponse = cancelSettled.value;
    expect(cancelResponse.status).toBe(201);
    expect(cancelResponse.body.cancellationRequested).toBe(true);

    const claim = claimSettled.status === 'fulfilled' ? claimSettled.value : null;
    if (claim && claim.id !== jobId) await revertForeignClaim(claim.id);

    // The ghost worker (whose lease expired) can never finish the job.
    await expect(jobs.complete(jobId, 'ghost-worker', { ghost: true } as Prisma.InputJsonValue)).rejects.toThrow(ConflictException);

    if (claim && claim.id === jobId) {
      // The rescuer claimed before cancellation landed: it must acknowledge the request.
      const beat = await jobs.heartbeat(jobId, 'rescuer');
      expect(beat.cancellationRequested).toBe(true);
      const ack = await jobs.acknowledgeCancellation(jobId, 'rescuer');
      expect(ack.status).toBe('CANCELLED');
    }

    const row = await prisma.workJob.findUnique({ where: { id: jobId } });
    expect(row?.status).toBe(JobStatus.CANCELLED);
    expect(row?.lockedBy).toBeNull();
  });

  it('applies exactly one restore when a checkpoint restore is double-tapped', async () => {
    const checkpoint = await api('POST', '/applications/' + applicationId + '/checkpoints', { label: 'stable-base' }, hans.tokens.accessToken);
    expect(checkpoint.status).toBe(201);
    const checkpointId = (checkpoint.body as { id: string }).id;

    const mutate = await api('POST', '/applications/' + applicationId + '/files', { path: basePath, content: v4Content, language: 'typescript', expectedRevision: 1 }, hans.tokens.accessToken);
    expect(mutate.status).toBe(201);

    const restore = () => api('POST', '/applications/' + applicationId + '/checkpoints/' + checkpointId + '/restore', {}, hans.tokens.accessToken);
    const raced = await Promise.all([restore(), restore()]);
    expect(raced.every((response) => [201, 409].includes(response.status))).toBe(true);

    const winners = raced.filter((response) => response.status === 201);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    const changed = winners.reduce((sum, response) => sum + (response.body.changedFiles as number), 0);
    expect(changed).toBe(1);

    const file = await readBaseFile(hans.tokens.accessToken);
    expect(file?.revision).toBe(3);
    expect(file?.content).toBe(v1Content);
    expect(await revisionRowCount()).toBe(3);
  });

  it('replays an already-applied restore as a clean idempotent no-op', async () => {
    const checkpoints = await api('GET', '/applications/' + applicationId + '/checkpoints', undefined, hans.tokens.accessToken);
    expect(checkpoints.status).toBe(200);
    const checkpointId = (checkpoints.body as unknown as Array<{ id: string; label: string }>).find((c) => c.label === 'stable-base')!.id;

    const before = await revisionRowCount();
    const replay = await api('POST', '/applications/' + applicationId + '/checkpoints/' + checkpointId + '/restore', {}, hans.tokens.accessToken);
    expect(replay.status).toBe(201);
    expect(replay.body.changedFiles).toBe(0);
    expect(replay.body.atomic).toBe(true);

    const file = await readBaseFile(hans.tokens.accessToken);
    expect(file?.revision).toBe(3);
    expect(file?.content).toBe(v1Content);
    expect(await revisionRowCount()).toBe(before);
  });

  it('resolves a restore racing a live file write with exactly one winner and no corruption', async () => {
    const checkpoints = await api('GET', '/applications/' + applicationId + '/checkpoints', undefined, hans.tokens.accessToken);
    const checkpointId = (checkpoints.body as unknown as Array<{ id: string; label: string }>).find((c) => c.label === 'stable-base')!.id;

    // Move the file away from the snapshot so the restore has real work to do.
    const mutate = await api('POST', '/applications/' + applicationId + '/files', { path: basePath, content: v4Content, language: 'typescript', expectedRevision: 3 }, hans.tokens.accessToken);
    expect(mutate.status).toBe(201);

    const restorePromise = api('POST', '/applications/' + applicationId + '/checkpoints/' + checkpointId + '/restore', {}, hans.tokens.accessToken);
    const writePromise = api('POST', '/applications/' + applicationId + '/files', { path: basePath, content: v5Content, language: 'typescript', expectedRevision: 4 }, hans.tokens.accessToken);
    const raced = await Promise.all([restorePromise, writePromise]);
    expect(sortedStatuses(raced)).toEqual([201, 409]);

    const file = await readBaseFile(hans.tokens.accessToken);
    expect(file?.revision).toBe(5);
    const restoreWon = raced[0].status === 201;
    expect(file?.content).toBe(restoreWon ? v1Content : v5Content);

    // The immutable revision chain stays contiguous: exactly one revision 5.
    const revision5 = await prisma.fileRevision.count({ where: { fileId: baseFileId, revision: 5 } });
    expect(revision5).toBe(1);
    expect(await revisionRowCount()).toBe(5);
  });

  it('snapshots consistently when two checkpoints are created simultaneously', async () => {
    const create = () => api('POST', '/applications/' + applicationId + '/checkpoints', { label: 'pre-deploy' }, hans.tokens.accessToken);
    const raced = await Promise.all([create(), create()]);
    expect(raced.every((response) => response.status === 201)).toBe(true);

    const list = await api('GET', '/applications/' + applicationId + '/checkpoints', undefined, hans.tokens.accessToken);
    expect(list.status).toBe(200);
    const preDeploy = (list.body as unknown as Array<{ id: string; label: string; fileCount: number }>).filter((c) => c.label === 'pre-deploy');
    expect(preDeploy.length).toBe(2);
    expect(new Set(preDeploy.map((c) => c.id)).size).toBe(2);
    preDeploy.forEach((c) => expect(c.fileCount).toBe(1));
  });

  it('runs a double-tapped verification as independent honest runs', async () => {
    const raced = await Promise.all([
      api('POST', '/applications/' + applicationId + '/verifications', {}, hans.tokens.accessToken),
      api('POST', '/applications/' + applicationId + '/verifications', {}, ines.tokens.accessToken),
    ]);
    expect(raced.every((response) => [201, 409].includes(response.status))).toBe(true);

    // A run request executes every verification kind and returns one run per kind.
    const created = raced.filter((response) => response.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    const createdRuns: Array<{ id: string; status: string }> = [];
    created.forEach((response) => {
      const runs = response.body as unknown as Array<{ id: string; kind: string; status: string }>;
      expect(Array.isArray(runs)).toBe(true);
      expect(runs.length).toBe(3);
      runs.forEach((run) => {
        expect(run.id).toBeDefined();
        expect(['PASSED', 'SKIPPED']).toContain(run.status);
        createdRuns.push(run);
      });
    });

    const history = await api('GET', '/applications/' + applicationId + '/verifications', undefined, hans.tokens.accessToken);
    expect(history.status).toBe(200);
    const listed = history.body as unknown as Array<{ id: string; status: string }>;
    for (const run of createdRuns) {
      const found = listed.find((candidate) => candidate.id === run.id);
      expect(found).toBeDefined();
      expect(found?.status).toBe(run.status);
    }
  });

  it('grants exactly one planning lease when two planners race and always leaves the graph recoverable', async () => {
    const graph = await api('POST', '/applications/' + applicationId + '/work-graphs', { title: 'Lease Race Graph', sourcePrompt: 'Build a tiny billing service.' }, hans.tokens.accessToken);
    const graphId = (graph.body as { id: string }).id;
    const before = await prisma.workGraph.findUnique({ where: { id: graphId }, select: { version: true } });

    const raced = await Promise.allSettled([
      planner.plan(hans.userId, graphId),
      planner.plan(ines.userId, graphId),
    ]);
    raced.forEach((outcome) => expect(outcome.status).toBe('rejected'));

    const conflicts = raced.filter((outcome) => outcome.status === 'rejected' && outcome.reason instanceof ConflictException);
    const unavailables = raced.filter((outcome) => outcome.status === 'rejected' && outcome.reason instanceof ServiceUnavailableException);
    expect(conflicts.length).toBe(1);
    expect(unavailables.length).toBe(1);

    // Exactly one lease was claimed (single version bump) and it was fully released.
    const after = await prisma.workGraph.findUnique({
      where: { id: graphId },
      select: { status: true, planningToken: true, planningLeaseExpiresAt: true, version: true, nodes: { select: { key: true } } },
    });
    expect(after?.status).toBe(WorkGraphStatus.DRAFT);
    expect(after?.planningToken).toBeNull();
    expect(after?.planningLeaseExpiresAt).toBeNull();
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(after?.nodes.length).toBe(1);
    expect(after?.nodes[0]?.key).toBe('user-request');
  });

  it('refuses planning while a lease is live and recovers an expired lease', async () => {
    const graph = await api('POST', '/applications/' + applicationId + '/work-graphs', { title: 'Lease Recovery Graph', sourcePrompt: 'Build a tiny search service.' }, hans.tokens.accessToken);
    const graphId = (graph.body as { id: string }).id;
    const before = await prisma.workGraph.findUnique({ where: { id: graphId }, select: { version: true } });

    // Simulate a live lease held by another planner.
    await prisma.workGraph.update({
      where: { id: graphId },
      data: {
        status: WorkGraphStatus.PLANNING,
        planningToken: 'held-by-someone',
        planningLeaseExpiresAt: new Date(Date.now() + 60_000),
        version: { increment: 1 },
      },
    });
    await expect(planner.plan(hans.userId, graphId)).rejects.toThrow(ConflictException);

    // Once the lease expires the graph is recoverable by a new planner.
    await prisma.workGraph.update({
      where: { id: graphId },
      data: { planningLeaseExpiresAt: new Date(Date.now() - 60_000) },
    });
    // No AI provider is configured in CI, so the recovered planner claims the
    // lease, fails honestly, and must leave the graph back in DRAFT.
    await expect(planner.plan(hans.userId, graphId)).rejects.toThrow(ServiceUnavailableException);

    const after = await prisma.workGraph.findUnique({
      where: { id: graphId },
      select: { status: true, planningToken: true, planningLeaseExpiresAt: true, version: true },
    });
    expect(after?.status).toBe(WorkGraphStatus.DRAFT);
    expect(after?.planningToken).toBeNull();
    expect(after?.planningLeaseExpiresAt).toBeNull();
    expect(after?.version).toBe((before?.version ?? 0) + 2);
  });
});
