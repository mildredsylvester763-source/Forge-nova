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
 * Key-authenticated application creation against the real app and the
 * real CI PostgreSQL. Grounded in the market leaders: GitHub creates
 * organization repositories from tokens inside a specified
 * organization (the token membership is the tenant), and Vercel creates
 * projects with a Bearer token where only the name is required. The
 * keyed create mirrors the JWT create exactly - same select shape, same
 * trim law, same honest single audit row, same application.created
 * event - with the acting key attributed in the organization trail. The
 * writable tenant bound refuses foreign, missing, and archived projects
 * with one uniform 404 that never leaks what exists in other tenants,
 * and refusals never write audit rows.
 */
suite('GENESIS genapi application create flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId: string;
  let foreignOrganizationId: string;
  let projectAId: string;
  let projectSecondId: string;
  let projectThirdId: string;
  let foreignProjectId: string;
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
    const email = 'genesis-appnew-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'application-create-password-123',
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

  const orgCreateCount = () =>
    prisma.auditEvent.count({
      where: { organizationId, action: 'application.create' },
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

  it('seeds two organizations, projects, and scoped keys', async () => {
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

    projectAId = await createProject(
      hank.tokens.accessToken,
      workspaceAId,
      'Create Project ' + runId,
    );
    projectSecondId = await createProject(
      hank.tokens.accessToken,
      workspaceAId,
      'Create Second Project ' + runId,
    );
    projectThirdId = await createProject(
      hank.tokens.accessToken,
      workspaceAId,
      'Create Third Project ' + runId,
    );
    foreignProjectId = await createProject(
      iris.tokens.accessToken,
      foreignWorkspaceId,
      'Foreign Create Project ' + runId,
    );

    const seedApp = await api(
      'POST',
      '/projects/' + projectAId + '/applications',
      { name: 'Seed App ' + runId, framework: 'react', runtime: 'node' },
      hank.tokens.accessToken,
    );
    expect(seedApp.status).toBe(201);

    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'Create Writer', [
      'READ_ORGANIZATION',
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
    readerKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Create Reader',
      ['READ_APPLICATIONS'],
    );
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Create Short Lived',
      ['WRITE_APPLICATIONS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Create Revoked',
      ['WRITE_APPLICATIONS'],
    );
    irisWriter = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Foreign Writer', [
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
    ]);
  });

  it('creates an application that mirrors the JWT create shape exactly', async () => {
    const keyed = await api(
      'POST',
      '/genapi/projects/' + projectAId + '/applications',
      {
        name: '  Keyed App ' + runId + '  ',
        description: '  Created by a key  ',
        framework: 'nuxt',
        runtime: 'node',
      },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    const body = keyed.body as {
      id: string;
      projectId: string;
      name: string;
      description: string;
      status: string;
      framework: string;
      runtime: string;
      createdAt: string;
      updatedAt: string;
    };
    expect(body.projectId).toBe(projectAId);
    expect(body.name).toBe('Keyed App ' + runId);
    expect(body.description).toBe('Created by a key');
    expect(body.framework).toBe('nuxt');
    expect(body.runtime).toBe('node');
    expect(typeof body.createdAt).toBe('string');
    expect(typeof body.updatedAt).toBe('string');

    const truth = await prisma.application.findUnique({
      where: { id: body.id },
      select: { name: true, description: true, framework: true, runtime: true, projectId: true },
    });
    expect(truth?.name).toBe('Keyed App ' + runId);
    expect(truth?.description).toBe('Created by a key');
    expect(truth?.framework).toBe('nuxt');
    expect(truth?.runtime).toBe('node');
    expect(truth?.projectId).toBe(projectAId);

    const jwtList = await api(
      'GET',
      '/projects/' + projectAId + '/applications',
      undefined,
      hank.tokens.accessToken,
    );
    expect(jwtList.status).toBe(200);
    const rows = jwtList.body as unknown as Array<{ id: string }>;
    expect(rows.some((row) => row.id === body.id)).toBe(true);
  });

  it('honors the partial create law where only the name is required', async () => {
    const keyed = await api(
      'POST',
      '/genapi/projects/' + projectAId + '/applications',
      { name: 'Name Only App ' + runId },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    const body = keyed.body as {
      description: string | null;
      framework: string | null;
      runtime: string | null;
    };
    expect(body.description).toBeNull();
    expect(body.framework).toBeNull();
    expect(body.runtime).toBeNull();
  });

  it('attributes the create to the acting key in the organization trail', async () => {
    const keyed = await api(
      'POST',
      '/genapi/projects/' + projectAId + '/applications',
      { name: 'Attributed App ' + runId },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    const createdId = (keyed.body as { id: string }).id;

    const rows = await prisma.auditEvent.findMany({
      where: { organizationId, action: 'application.create', resourceId: createdId },
      select: { actorUserId: true, metadata: true },
    });
    expect(rows.length).toBe(1);
    const metadata = rows[0].metadata as {
      via?: string;
      apiKeyId?: string;
      apiKeyName?: string;
      applicationId?: string;
      projectId?: string;
    };
    expect(metadata.via).toBe('genapi');
    expect(metadata.apiKeyId).toBe(writerKey.id);
    expect(metadata.apiKeyName).toBe('Create Writer');
    expect(metadata.applicationId).toBe(createdId);
    expect(metadata.projectId).toBe(projectAId);
    expect(rows[0].actorUserId).toBe(hank.userId);

    const trail = await api('GET', '/genapi/audit-events', undefined, writerKey.key);
    expect(trail.status).toBe(200);
    const trailActions = (trail.body as unknown as Array<{ action: string }>).map(
      (row) => row.action,
    );
    expect(trailActions).toContain('application.create');
  });

  it('refuses a read-only key with one message and writes nothing', async () => {
    const before = await orgCreateCount();
    const refused = await api(
      'POST',
      '/genapi/projects/' + projectAId + '/applications',
      { name: 'Refused App ' + runId },
      readerKey.key,
    );
    expect(refused.status).toBe(403);
    expect((refused.body as { message: string }).message).toBe(
      'The API key does not grant the required scope.',
    );
    expect(await orgCreateCount()).toBe(before);
  });

  it('tenant-bounds the create with one uniform 404 and no audit rows', async () => {
    const before = await orgCreateCount();
    const messages = new Set<string>();

    const foreignProject = await api(
      'POST',
      '/genapi/projects/' + projectAId + '/applications',
      { name: 'Foreign Attempt ' + runId },
      irisWriter.key,
    );
    expect(foreignProject.status).toBe(404);
    messages.add((foreignProject.body as { message: string }).message);

    const ownProjectFromForeignKey = await api(
      'POST',
      '/genapi/projects/' + foreignProjectId + '/applications',
      { name: 'Foreign Project Attempt ' + runId },
      writerKey.key,
    );
    expect(ownProjectFromForeignKey.status).toBe(404);
    messages.add((ownProjectFromForeignKey.body as { message: string }).message);

    const unknownProject = await api(
      'POST',
      '/genapi/projects/does-not-exist-at-all/applications',
      { name: 'Unknown Project Attempt ' + runId },
      writerKey.key,
    );
    expect(unknownProject.status).toBe(404);
    messages.add((unknownProject.body as { message: string }).message);

    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Project not found.');
    expect(await orgCreateCount()).toBe(before);
  });

  it('refuses creates inside an archived project exactly like the JWT law', async () => {
    const archive = await api(
      'POST',
      '/projects/' + projectSecondId + '/archive',
      {},
      hank.tokens.accessToken,
    );
    expect(archive.status).toBe(201);

    const refused = await api(
      'POST',
      '/genapi/projects/' + projectSecondId + '/applications',
      { name: 'Archived Project App ' + runId },
      writerKey.key,
    );
    expect(refused.status).toBe(404);
    expect((refused.body as { message: string }).message).toBe('Project not found.');
  });

  it('answers a create double-tap with two clean distinct applications', async () => {
    const before = await orgCreateCount();
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/projects/' + projectAId + '/applications',
        { name: 'Double Tap App ' + runId },
        writerKey.key,
      ),
      api(
        'POST',
        '/genapi/projects/' + projectAId + '/applications',
        { name: 'Double Tap App ' + runId },
        writerKey.key,
      ),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 201]);
    const firstId = (raced[0].body as { id: string }).id;
    const secondId = (raced[1].body as { id: string }).id;
    expect(firstId).not.toBe(secondId);
    expect(await orgCreateCount()).toBe(before + 2);
  });

  it('stays clean when a keyed create races a JWT create in the same project', async () => {
    const before = await orgCreateCount();
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/projects/' + projectAId + '/applications',
        { name: 'Keyed Raced App ' + runId },
        writerKey.key,
      ),
      api(
        'POST',
        '/projects/' + projectAId + '/applications',
        { name: 'Jwt Raced App ' + runId },
        hank.tokens.accessToken,
      ),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 201]);
    const keyedId = (raced[0].body as { id: string }).id;
    const jwtId = (raced[1].body as { id: string }).id;
    expect(keyedId).not.toBe(jwtId);

    const rows = await prisma.auditEvent.findMany({
      where: { action: 'application.create', resourceId: { in: [keyedId, jwtId] } },
      select: { metadata: true },
    });
    expect(rows.length).toBe(2);
    const viaValues = rows.map(
      (row) => ((row.metadata as { via?: string })?.via ?? 'user'),
    );
    expect(viaValues.filter((via) => via === 'genapi').length).toBe(1);
    expect(await orgCreateCount()).toBe(before + 1);
  });

  it('stays clean when a keyed create races a JWT project archive', async () => {
    const raced = await Promise.all([
      api(
        'POST',
        '/genapi/projects/' + projectThirdId + '/applications',
        { name: 'Archive Raced App ' + runId },
        writerKey.key,
      ),
      api(
        'POST',
        '/projects/' + projectThirdId + '/archive',
        {},
        hank.tokens.accessToken,
      ),
    ]);
    const createStatus = raced[0].status;
    expect([201, 404]).toContain(createStatus);
    expect(raced[1].status).toBe(201);

    const project = await prisma.project.findUnique({
      where: { id: projectThirdId },
      select: { status: true },
    });
    expect(project?.status).toBe('ARCHIVED');

    if (createStatus === 201) {
      const createdId = (raced[0].body as { id: string }).id;
      const created = await prisma.application.findUnique({
        where: { id: createdId },
        select: { id: true },
      });
      expect(created?.id).toBe(createdId);
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

    const revokedCreate = await api(
      'POST',
      '/genapi/projects/' + projectAId + '/applications',
      { name: 'Revoked App ' + runId },
      revokedKey.key,
    );
    expect(revokedCreate.status).toBe(401);
    expect((revokedCreate.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredCreate = await api(
      'POST',
      '/genapi/projects/' + projectAId + '/applications',
      { name: 'Expired App ' + runId },
      shortLivedKey.key,
    );
    expect(expiredCreate.status).toBe(401);
    expect((expiredCreate.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    const unauthenticated = await api(
      'POST',
      '/genapi/projects/' + projectAId + '/applications',
      { name: 'No Auth App ' + runId },
    );
    expect(unauthenticated.status).toBe(401);
    expect((unauthenticated.body as { message: string }).message).toBe(
      'A valid GENESIS API key is required.',
    );
  });
});
