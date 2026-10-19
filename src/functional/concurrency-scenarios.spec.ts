import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

const hasDatabase = typeof process.env.DATABASE_URL === 'string'
  && process.env.DATABASE_URL.startsWith('postgres');
const hasJwtSecret = typeof process.env.JWT_ACCESS_SECRET === 'string'
  && process.env.JWT_ACCESS_SECRET.length >= 32;
const suite = hasDatabase && hasJwtSecret ? describe : describe.skip;

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface UserContext {
  email: string;
  password: string;
  tokens: TokenPair;
  userId: string;
}

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Scenario suite: every test hammers a real running app backed by a real
 * database with SIMULTANEOUS requests, double-taps, and replayed actions,
 * then asserts the exact product behavior: exactly one winner, clean
 * refusal for the loser, and a consistent final state. No mocks.
 */
suite('GENESIS concurrency and double-tap scenarios (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let dave: UserContext;
  let erin: UserContext;
  let frank: UserContext;
  let grace: UserContext;
  let organizationId: string;
  let workspaceId: string;
  let projectId: string;
  let applicationId: string;
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);
  const password = 'concurrency-test-password-123';

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
    const email = `genesis-conc-${name}-${runId}@example.com`;
    const response = await api('POST', '/auth/register', {
      email,
      password,
      displayName: name,
    });
    expect(response.status).toBe(201);
    const user = response.body.user as { id: string };
    createdUserIds.push(user.id);
    return {
      email,
      password,
      tokens: {
        accessToken: response.body.accessToken as string,
        refreshToken: response.body.refreshToken as string,
      },
      userId: user.id,
    };
  };

  const membersOf = async (token: string) => {
    const response = await api('GET', '/organizations/' + organizationId + '/members', undefined, token);
    expect(response.status).toBe(200);
    return response.body as unknown as Array<{
      id: string;
      role: string;
      user: { id: string; email: string };
    }>;
  };

  const sortedStatuses = (responses: ApiResponse[]) =>
    responses.map((response) => response.status).sort((a, b) => a - b);

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
    const { PrismaService } = await import('../database/prisma.service');
    const prisma = app.get(PrismaService);
    if (createdUserIds.length > 0) {
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('lets exactly one of two simultaneous duplicate registrations win', async () => {
    dave = await registerUser('dave');
    erin = await registerUser('erin');

    const frankEmail = `genesis-conc-frank-${runId}@example.com`;
    const payload = { email: frankEmail, password, displayName: 'frank' };
    const raced = await Promise.all([
      api('POST', '/auth/register', payload),
      api('POST', '/auth/register', payload),
    ]);
    expect(sortedStatuses(raced)).toEqual([201, 409]);

    const winner = raced.find((response) => response.status === 201)!;
    const winnerUser = winner.body.user as { id: string };
    createdUserIds.push(winnerUser.id);
    frank = {
      email: frankEmail,
      password,
      tokens: {
        accessToken: winner.body.accessToken as string,
        refreshToken: winner.body.refreshToken as string,
      },
      userId: winnerUser.id,
    };

    // The double-tap must not corrupt the account: the winner can log in.
    const login = await api('POST', '/auth/login', { email: frankEmail, password });
    expect(login.status).toBe(200);
  });

  it('rotates a refresh token exactly once when the same token is replayed simultaneously', async () => {
    const token = dave.tokens.refreshToken;
    const raced = await Promise.all([
      api('POST', '/auth/refresh', { refreshToken: token }),
      api('POST', '/auth/refresh', { refreshToken: token }),
    ]);
    expect(sortedStatuses(raced)).toEqual([200, 401]);

    const winner = raced.find((response) => response.status === 200)!;
    const newToken = winner.body.refreshToken as string;
    expect(newToken).not.toBe(token);

    // The winner's rotated token works; replaying the stolen original is dead.
    const useRotated = await api('POST', '/auth/refresh', { refreshToken: newToken });
    expect(useRotated.status).toBe(200);
    dave.tokens = {
      accessToken: useRotated.body.accessToken as string,
      refreshToken: useRotated.body.refreshToken as string,
    };
    const replayOriginal = await api('POST', '/auth/refresh', { refreshToken: token });
    expect(replayOriginal.status).toBe(401);
  });

  it('admits a member exactly once when two admins add the same email simultaneously', async () => {
    const organizations = await api('GET', '/organizations', undefined, dave.tokens.accessToken);
    expect(organizations.status).toBe(200);
    organizationId = (organizations.body as unknown as Array<{ id: string }>)[0].id;

    const addErin = await api(
      'POST',
      '/organizations/' + organizationId + '/members',
      { email: erin.email, role: 'ADMIN' },
      dave.tokens.accessToken,
    );
    expect(addErin.status).toBe(201);

    const raced = await Promise.all([
      api('POST', '/organizations/' + organizationId + '/members', { email: frank.email, role: 'VIEWER' }, dave.tokens.accessToken),
      api('POST', '/organizations/' + organizationId + '/members', { email: frank.email, role: 'VIEWER' }, erin.tokens.accessToken),
    ]);
    expect(sortedStatuses(raced)).toEqual([201, 409]);

    const members = await membersOf(dave.tokens.accessToken);
    const frankMemberships = members.filter((member) => member.user.email === frank.email);
    expect(frankMemberships.length).toBe(1);
    expect(frankMemberships[0].role).toBe('VIEWER');
  });

  it('keeps exactly one consistent membership when two admins change the same role simultaneously', async () => {
    const members = await membersOf(dave.tokens.accessToken);
    const frankMembership = members.find((member) => member.user.email === frank.email)!;

    const raced = await Promise.all([
      api('PATCH', '/organizations/' + organizationId + '/members/' + frankMembership.id, { role: 'DEVELOPER' }, dave.tokens.accessToken),
      api('PATCH', '/organizations/' + organizationId + '/members/' + frankMembership.id, { role: 'BILLING' }, erin.tokens.accessToken),
    ]);
    // Last committed write wins; neither admin may see a server error.
    expect(raced.every((response) => response.status === 200)).toBe(true);

    const after = await membersOf(dave.tokens.accessToken);
    const afterFrank = after.filter((member) => member.user.email === frank.email);
    expect(afterFrank.length).toBe(1);
    expect(['DEVELOPER', 'BILLING']).toContain(afterFrank[0].role);
  });

  it('removes a member exactly once when two admins press remove at the same time', async () => {
    grace = await registerUser('grace');
    const added = await api(
      'POST',
      '/organizations/' + organizationId + '/members',
      { email: grace.email, role: 'VIEWER' },
      dave.tokens.accessToken,
    );
    expect(added.status).toBe(201);

    const members = await membersOf(dave.tokens.accessToken);
    const graceMembership = members.find((member) => member.user.email === grace.email)!;

    const raced = await Promise.all([
      api('DELETE', '/organizations/' + organizationId + '/members/' + graceMembership.id, undefined, dave.tokens.accessToken),
      api('DELETE', '/organizations/' + organizationId + '/members/' + graceMembership.id, undefined, erin.tokens.accessToken),
    ]);
    expect(sortedStatuses(raced)).toEqual([200, 404]);

    const after = await membersOf(dave.tokens.accessToken);
    expect(after.some((member) => member.user.email === grace.email)).toBe(false);

    // Only the winning removal is audited; the losing 404 writes no audit row.
    const trail = await api('GET', '/organizations/' + organizationId + '/audit-events', undefined, dave.tokens.accessToken);
    expect(trail.status).toBe(200);
    const removals = (trail.body as unknown as Array<{ action: string }>).filter(
      (event) => event.action === 'organization.member.remove',
    );
    expect(removals.length).toBe(1);
  });

  it('transfers ownership safely under a double-tap and never leaves two owners', async () => {
    const members = await membersOf(dave.tokens.accessToken);
    const erinMembership = members.find((member) => member.user.email === erin.email)!;
    const target = { memberId: erinMembership.id };

    const raced = await Promise.all([
      api('POST', '/organizations/' + organizationId + '/ownership-transfer', target, dave.tokens.accessToken),
      api('POST', '/organizations/' + organizationId + '/ownership-transfer', target, dave.tokens.accessToken),
    ]);
    // Both taps may land (idempotent end state) or the second may arrive after
    // the owner was demoted (403). Either way the invariant below must hold.
    expect(raced.every((response) => [201, 403].includes(response.status))).toBe(true);
    expect(raced.some((response) => response.status === 201)).toBe(true);

    const after = await membersOf(dave.tokens.accessToken);
    const owners = after.filter((member) => member.role === 'OWNER');
    expect(owners.length).toBe(1);
    expect(owners[0].user.email).toBe(erin.email);
    expect(after.find((member) => member.user.email === dave.email)?.role).toBe('ADMIN');
  });

  it('resolves concurrent same-revision file writes with exactly one winner', async () => {
    const workspaces = await api('GET', '/workspaces', undefined, dave.tokens.accessToken);
    expect(workspaces.status).toBe(200);
    workspaceId = (workspaces.body as unknown as Array<{ id: string }>)[0].id;

    const project = await api(
      'POST',
      '/workspaces/' + workspaceId + '/projects',
      { name: 'Concurrency Project' },
      dave.tokens.accessToken,
    );
    expect(project.status).toBe(201);
    projectId = (project.body as { id: string }).id;

    const application = await api(
      'POST',
      '/projects/' + projectId + '/applications',
      { name: 'Race App' },
      dave.tokens.accessToken,
    );
    expect(application.status).toBe(201);
    applicationId = (application.body as { id: string }).id;

    const created = await api(
      'POST',
      '/applications/' + applicationId + '/files',
      { path: 'raced.ts', content: 'export const v = 1;', language: 'typescript' },
      dave.tokens.accessToken,
    );
    expect(created.status).toBe(201);

    // Three writers all claim revision 1: exactly one wins, the rest conflict.
    const updatePayload = { path: 'raced.ts', content: 'export const v = 2;', language: 'typescript', expectedRevision: 1 };
    const raced = await Promise.all([
      api('POST', '/applications/' + applicationId + '/files', updatePayload, dave.tokens.accessToken),
      api('POST', '/applications/' + applicationId + '/files', updatePayload, dave.tokens.accessToken),
      api('POST', '/applications/' + applicationId + '/files', updatePayload, dave.tokens.accessToken),
    ]);
    expect(sortedStatuses(raced)).toEqual([201, 409, 409]);

    const files = await api('GET', '/applications/' + applicationId + '/files', undefined, dave.tokens.accessToken);
    expect(files.status).toBe(200);
    const list = files.body as unknown as Array<{ path: string; revision: number }>;
    expect(list.find((file) => file.path === 'raced.ts')?.revision).toBe(2);

    // Double-tap creating the same NEW path: one create, one conflict.
    const createPayload = { path: 'double-tap.ts', content: 'export const t = true;' };
    const tap = await Promise.all([
      api('POST', '/applications/' + applicationId + '/files', createPayload, dave.tokens.accessToken),
      api('POST', '/applications/' + applicationId + '/files', createPayload, dave.tokens.accessToken),
    ]);
    expect(sortedStatuses(tap)).toEqual([201, 409]);
  });

  it('archives idempotently under a double-tap, blocks writes, and restores exactly once', async () => {
    const archive = () =>
      api('POST', '/projects/' + projectId + '/applications/' + applicationId + '/archive', {}, dave.tokens.accessToken);
    const raced = await Promise.all([archive(), archive()]);
    // Idempotent archive: both may succeed, or the second misses the write-role
    // window once the first commit lands. Never a server error.
    expect(raced.every((response) => [201, 404].includes(response.status))).toBe(true);
    expect(raced.some((response) => response.status === 201)).toBe(true);

    const blockedWrite = await api(
      'POST',
      '/applications/' + applicationId + '/files',
      { path: 'blocked.ts', content: 'export const b = true;' },
      dave.tokens.accessToken,
    );
    expect(blockedWrite.status).toBe(404);

    const firstRestore = await api(
      'POST',
      '/projects/' + projectId + '/applications/' + applicationId + '/restore',
      {},
      dave.tokens.accessToken,
    );
    expect(firstRestore.status).toBe(201);
    expect(firstRestore.body).toMatchObject({ status: 'PLANNING' });

    const secondRestore = await api(
      'POST',
      '/projects/' + projectId + '/applications/' + applicationId + '/restore',
      {},
      dave.tokens.accessToken,
    );
    expect(secondRestore.status).toBe(404);

    const writeAfterRestore = await api(
      'POST',
      '/applications/' + applicationId + '/files',
      { path: 'unblocked.ts', content: 'export const u = true;' },
      dave.tokens.accessToken,
    );
    expect(writeAfterRestore.status).toBe(201);
  });
});
