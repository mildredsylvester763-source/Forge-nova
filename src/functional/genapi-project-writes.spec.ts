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
 * Keyed project write surface over the real app and the real CI
 * PostgreSQL. Grounded in the GitHub Projects REST surface: project
 * mutations need the Projects organization write permission while
 * reads need only the read permission, and the open and closed
 * states flip through that write surface, so archive and restore are
 * writes exactly like the metadata update. The keyed routes mirror
 * the JWT routes through shared cores so the two surfaces can never
 * drift apart. Every write is tenant-bounded to the key organization,
 * foreign and unknown targets answer one uniform 404 per guard,
 * refusals never write audit rows, and only a landed restore writes
 * exactly one attributed audit row because the restore claim is
 * atomic and ends exactly one way.
 */
suite('GENESIS keyed project write flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let hank: UserContext;
  let iris: UserContext;
  let organizationId = '';
  let foreignOrganizationId = '';
  let workspaceAId = '';
  let foreignWorkspaceId = '';
  let updateTargetId = '';
  let archTargetId = '';
  let restoreTargetId = '';
  let foreignProjectId = '';
  let keyedProjectId = '';
  let jwtProjectId = '';
  let writerKey: KeyContext;
  let readerKey: KeyContext;
  let orgWriterKey: KeyContext;
  let appWriterKey: KeyContext;
  let auditReaderKey: KeyContext;
  let shortLivedKey: KeyContext;
  let revokedKey: KeyContext;
  let irisWriterKey: KeyContext;
  let jackKey: KeyContext | null = null;
  let jackOrgId = '';
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);
  const password = 'gpw-project-writes-password-123';

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
    const email = 'genesis-gpw-' + name + '-' + runId + '@example.com';
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
      tokens: {
        accessToken: response.body.accessToken as string,
        refreshToken: response.body.refreshToken as string,
      },
      userId: user.id,
    };
  };

  const createKey = async (
    accessToken: string,
    orgId: string,
    name: string,
    scopes: string[],
    expiresAt?: string,
  ): Promise<KeyContext> => {
    const response = await api(
      'POST',
      '/organizations/' + orgId + '/api-keys',
      { name, scopes, ...(expiresAt ? { expiresAt } : {}) },
      accessToken,
    );
    expect(response.status).toBe(201);
    const body = response.body as { id: string; key: string };
    expect(body.key).toMatch(/^gn_live_[A-Za-z0-9_-]{43}$/);
    return { id: body.id, key: body.key };
  };

  const auditCount = () => prisma.auditEvent.count({ where: { organizationId } });

  const projectRowsInOrganization = () =>
    prisma.project.count({ where: { workspace: { organizationId } } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({}).compile();
    await moduleRef.close();

    const { AppModule } = await import('../app.module');
    const testing = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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
    const orgIds = [organizationId, foreignOrganizationId, jackOrgId].filter((id) => id !== '');
    if (orgIds.length > 0) {
      await prisma.auditEvent.deleteMany({ where: { organizationId: { in: orgIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
    }
    if (jackOrgId !== '') {
      await prisma.organization.deleteMany({ where: { id: jackOrgId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it('seeds two organizations, projects, and scoped keys', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;
    const hankWorkspaces = await api('GET', '/workspaces', undefined, hank.tokens.accessToken);
    expect(hankWorkspaces.status).toBe(200);
    workspaceAId = (hankWorkspaces.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;
    const irisWorkspaces = await api('GET', '/workspaces', undefined, iris.tokens.accessToken);
    expect(irisWorkspaces.status).toBe(200);
    foreignWorkspaceId = (irisWorkspaces.body as unknown as Array<{ id: string }>)[0].id;

    const seed = async (name: string) => {
      const created = await api(
        'POST',
        '/workspaces/' + workspaceAId + '/projects',
        { name },
        hank.tokens.accessToken,
      );
      expect(created.status).toBe(201);
      return (created.body as { id: string }).id;
    };
    updateTargetId = await seed('GPW Update Target');
    archTargetId = await seed('GPW Archive Target');
    restoreTargetId = await seed('GPW Restore Target');

    const foreignSeed = await api(
      'POST',
      '/workspaces/' + foreignWorkspaceId + '/projects',
      { name: 'GPW Foreign Project' },
      iris.tokens.accessToken,
    );
    expect(foreignSeed.status).toBe(201);
    foreignProjectId = (foreignSeed.body as { id: string }).id;

    writerKey = await createKey(hank.tokens.accessToken, organizationId, 'Project Writer', ['READ_PROJECTS', 'WRITE_PROJECTS']);
    readerKey = await createKey(hank.tokens.accessToken, organizationId, 'Project Reader', ['READ_PROJECTS']);
    orgWriterKey = await createKey(hank.tokens.accessToken, organizationId, 'Org Writer', ['READ_ORGANIZATION', 'WRITE_ORGANIZATION']);
    appWriterKey = await createKey(hank.tokens.accessToken, organizationId, 'App Writer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    auditReaderKey = await createKey(hank.tokens.accessToken, organizationId, 'Audit Reader', ['READ_ORGANIZATION']);
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Short Lived',
      ['READ_PROJECTS', 'WRITE_PROJECTS'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(hank.tokens.accessToken, organizationId, 'Revoked', ['READ_PROJECTS', 'WRITE_PROJECTS']);
    irisWriterKey = await createKey(iris.tokens.accessToken, foreignOrganizationId, 'Iris Project Writer', ['READ_PROJECTS', 'WRITE_PROJECTS']);
  });

  it('mirrors the JWT create exactly with key-creator attribution', async () => {
    const before = await auditCount();

    const keyed = await api(
      'POST',
      '/genapi/workspaces/' + workspaceAId + '/projects',
      { name: '  Keyed Project ' + runId + '  ', description: '  First keyed project.  ' },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    const jwt = await api(
      'POST',
      '/workspaces/' + workspaceAId + '/projects',
      { name: 'Jwt Project ' + runId, description: 'Jwt project.' },
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(201);
    expect(Object.keys(keyed.body).sort()).toEqual(Object.keys(jwt.body).sort());

    const row = keyed.body as {
      id: string;
      workspaceId: string;
      ownerId: string;
      name: string;
      description: string;
      status: string;
    };
    expect(row.name).toBe('Keyed Project ' + runId);
    expect(row.description).toBe('First keyed project.');
    expect(row.workspaceId).toBe(workspaceAId);
    expect(row.ownerId).toBe(hank.userId);
    expect(row.status).toBe('ACTIVE');
    keyedProjectId = row.id;
    jwtProjectId = (jwt.body as { id: string }).id;

    const stored = await prisma.project.findUnique({
      where: { id: keyedProjectId },
      select: { ownerId: true, name: true, description: true, status: true },
    });
    expect(stored).toEqual({ ownerId: hank.userId, name: 'Keyed Project ' + runId, description: 'First keyed project.', status: 'ACTIVE' });

    const keyedList = await api('GET', '/genapi/workspaces/' + workspaceAId + '/projects', undefined, readerKey.key);
    expect(keyedList.status).toBe(200);
    expect((keyedList.body as unknown as Array<{ id: string }>).some((r) => r.id === keyedProjectId)).toBe(true);
    const jwtList = await api('GET', '/workspaces/' + workspaceAId + '/projects', undefined, hank.tokens.accessToken);
    expect(jwtList.status).toBe(200);
    expect((jwtList.body as unknown as Array<{ id: string }>).some((r) => r.id === keyedProjectId)).toBe(true);

    expect(await auditCount()).toBe(before);
  });

  it('refuses create attempts without side effects', async () => {
    const before = await auditCount();
    const rowsBefore = await projectRowsInOrganization();

    const scopeMessages = new Set<string>();
    for (const wrongKey of [readerKey, orgWriterKey, appWriterKey]) {
      const refused = await api(
        'POST',
        '/genapi/workspaces/' + workspaceAId + '/projects',
        { name: 'Refused ' + runId },
        wrongKey.key,
      );
      expect(refused.status).toBe(403);
      scopeMessages.add((refused.body as { message: string }).message);
    }
    expect(scopeMessages.size).toBe(1);
    expect(Array.from(scopeMessages)[0]).toBe('The API key does not grant the required scope.');

    const notFound = new Set<string>();
    const foreign = await api(
      'POST',
      '/genapi/workspaces/' + foreignWorkspaceId + '/projects',
      { name: 'Foreign Try ' + runId },
      writerKey.key,
    );
    expect(foreign.status).toBe(404);
    notFound.add((foreign.body as { message: string }).message);
    const unknown = await api(
      'POST',
      '/genapi/workspaces/does-not-exist-at-all/projects',
      { name: 'Unknown Try ' + runId },
      writerKey.key,
    );
    expect(unknown.status).toBe(404);
    notFound.add((unknown.body as { message: string }).message);
    expect(notFound.size).toBe(1);
    expect(Array.from(notFound)[0]).toBe('Workspace not found.');

    const invalid = await api('POST', '/genapi/workspaces/' + workspaceAId + '/projects', { name: '   ' }, writerKey.key);
    expect(invalid.status).toBe(400);
    const extra = await api('POST', '/genapi/workspaces/' + workspaceAId + '/projects', { name: 'Extra ' + runId, surprise: true }, writerKey.key);
    expect(extra.status).toBe(400);
    const longName = await api('POST', '/genapi/workspaces/' + workspaceAId + '/projects', { name: 'x'.repeat(121) }, writerKey.key);
    expect(longName.status).toBe(400);

    expect(await projectRowsInOrganization()).toBe(rowsBefore);
    expect(await auditCount()).toBe(before);
  });

  it('mirrors the JWT partial update exactly', async () => {
    const before = await auditCount();

    const keyed = await api(
      'POST',
      '/genapi/projects/' + updateTargetId + '/update',
      { description: 'Keyed update description.' },
      writerKey.key,
    );
    expect(keyed.status).toBe(201);
    const jwt = await api(
      'PATCH',
      '/projects/' + jwtProjectId,
      { description: 'Jwt update description.' },
      hank.tokens.accessToken,
    );
    expect(jwt.status).toBe(200);
    expect(Object.keys(keyed.body).sort()).toEqual(Object.keys(jwt.body).sort());

    const row = keyed.body as { id: string; name: string; description: string; status: string };
    expect(row.id).toBe(updateTargetId);
    expect(row.name).toBe('GPW Update Target');
    expect(row.description).toBe('Keyed update description.');
    expect(row.status).toBe('ACTIVE');

    // A description-only write leaves the name untouched; a name write trims.
    const trimmed = await api(
      'POST',
      '/genapi/projects/' + updateTargetId + '/update',
      { name: '  Trimmed GPW Name  ' },
      writerKey.key,
    );
    expect(trimmed.status).toBe(201);
    expect((trimmed.body as { name: string }).name).toBe('Trimmed GPW Name');

    const stored = await prisma.project.findUnique({
      where: { id: updateTargetId },
      select: { name: true, description: true, status: true },
    });
    expect(stored).toEqual({ name: 'Trimmed GPW Name', description: 'Keyed update description.', status: 'ACTIVE' });

    expect(await auditCount()).toBe(before);
  });

  it('archives like the JWT surface and blocks later writes', async () => {
    const before = await auditCount();

    const keyed = await api('POST', '/genapi/projects/' + archTargetId + '/archive', {}, writerKey.key);
    expect(keyed.status).toBe(201);
    const jwt = await api('POST', '/projects/' + restoreTargetId + '/archive', {}, hank.tokens.accessToken);
    expect(jwt.status).toBe(201);
    expect(Object.keys(keyed.body).sort()).toEqual(Object.keys(jwt.body).sort());
    expect((keyed.body as { id: string; status: string }).id).toBe(archTargetId);
    expect((keyed.body as { id: string; status: string }).status).toBe('ARCHIVED');

    const blockedJwtUpdate = await api('PATCH', '/projects/' + archTargetId, { name: 'Blocked ' + runId }, hank.tokens.accessToken);
    expect(blockedJwtUpdate.status).toBe(404);
    const blockedKeyedUpdate = await api('POST', '/genapi/projects/' + archTargetId + '/update', { name: 'Blocked Keyed ' + runId }, writerKey.key);
    expect(blockedKeyedUpdate.status).toBe(404);
    expect((blockedKeyedUpdate.body as { message: string }).message).toBe('Project not found.');
    const blockedKeyedArchive = await api('POST', '/genapi/projects/' + archTargetId + '/archive', {}, writerKey.key);
    expect(blockedKeyedArchive.status).toBe(404);
    expect((blockedKeyedArchive.body as { message: string }).message).toBe('Project not found.');
    const blockedApp = await api('POST', '/genapi/projects/' + archTargetId + '/applications', { name: 'Blocked App ' + runId }, appWriterKey.key);
    expect(blockedApp.status).toBe(404);

    const read = await api('GET', '/genapi/projects/' + archTargetId, undefined, readerKey.key);
    expect(read.status).toBe(200);
    expect((read.body as { status: string }).status).toBe('ARCHIVED');

    expect(await auditCount()).toBe(before);
  });

  it('refuses updates without side effects', async () => {
    const before = await auditCount();
    const stored = await prisma.project.findUnique({
      where: { id: updateTargetId },
      select: { name: true, description: true },
    });
    const rowsBefore = await projectRowsInOrganization();

    const notFound = new Set<string>();
    const foreign = await api('POST', '/genapi/projects/' + foreignProjectId + '/update', { name: 'Foreign Edit ' + runId }, writerKey.key);
    expect(foreign.status).toBe(404);
    notFound.add((foreign.body as { message: string }).message);
    const unknown = await api('POST', '/genapi/projects/does-not-exist-at-all/update', { name: 'Unknown Edit ' + runId }, writerKey.key);
    expect(unknown.status).toBe(404);
    notFound.add((unknown.body as { message: string }).message);
    const archived = await api('POST', '/genapi/projects/' + archTargetId + '/update', { name: 'Archived Edit ' + runId }, writerKey.key);
    expect(archived.status).toBe(404);
    notFound.add((archived.body as { message: string }).message);
    expect(notFound.size).toBe(1);
    expect(Array.from(notFound)[0]).toBe('Project not found.');

    const scope = await api('POST', '/genapi/projects/' + updateTargetId + '/update', { name: 'Scope Edit ' + runId }, readerKey.key);
    expect(scope.status).toBe(403);
    expect((scope.body as { message: string }).message).toBe('The API key does not grant the required scope.');

    const invalid = await api('POST', '/genapi/projects/' + updateTargetId + '/update', { name: '   ' }, writerKey.key);
    expect(invalid.status).toBe(400);

    const after = await prisma.project.findUnique({
      where: { id: updateTargetId },
      select: { name: true, description: true },
    });
    expect(after).toEqual(stored);
    expect(await projectRowsInOrganization()).toBe(rowsBefore);
    expect(await auditCount()).toBe(before);
  });

  it('restores an archived project with exactly one attributed audit row', async () => {
    const keyed = await api('POST', '/genapi/projects/' + restoreTargetId + '/restore', {}, writerKey.key);
    expect(keyed.status).toBe(201);
    const row = keyed.body as { id: string; workspaceId: string; name: string; status: string };
    expect(row.id).toBe(restoreTargetId);
    expect(row.workspaceId).toBe(workspaceAId);
    expect(row.status).toBe('ACTIVE');

    const rows = await prisma.auditEvent.findMany({
      where: { action: 'project.restore', resourceId: restoreTargetId },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].actorUserId).toBe(hank.userId);
    expect(rows[0].organizationId).toBe(organizationId);
    expect(rows[0].resourceType).toBe('project');
    expect(rows[0].outcome).toBe('SUCCESS');
    const metadata = rows[0].metadata as Record<string, unknown>;
    expect(metadata.via).toBe('genapi');
    expect(metadata.apiKeyId).toBe(writerKey.id);
    expect(metadata.apiKeyName).toBe('Project Writer');
    expect(metadata.projectId).toBe(restoreTargetId);

    const trail = await api('GET', '/genapi/audit-events', undefined, auditReaderKey.key);
    expect(trail.status).toBe(200);
    const trailRows = trail.body as unknown as Array<{ action: string; resourceId: string | null }>;
    expect(trailRows.some((t) => t.action === 'project.restore' && t.resourceId === restoreTargetId)).toBe(true);

    const updateAfter = await api('PATCH', '/projects/' + restoreTargetId, { description: 'Alive again.' }, hank.tokens.accessToken);
    expect(updateAfter.status).toBe(200);
  });

  it('refuses restores without side effects', async () => {
    const before = await auditCount();

    const notFound = new Set<string>();
    const active = await api('POST', '/genapi/projects/' + updateTargetId + '/restore', {}, writerKey.key);
    expect(active.status).toBe(404);
    notFound.add((active.body as { message: string }).message);
    const unknown = await api('POST', '/genapi/projects/does-not-exist-at-all/restore', {}, writerKey.key);
    expect(unknown.status).toBe(404);
    notFound.add((unknown.body as { message: string }).message);
    const foreignArchive = await api('POST', '/projects/' + foreignProjectId + '/archive', {}, iris.tokens.accessToken);
    expect(foreignArchive.status).toBe(201);
    const foreign = await api('POST', '/genapi/projects/' + foreignProjectId + '/restore', {}, writerKey.key);
    expect(foreign.status).toBe(404);
    notFound.add((foreign.body as { message: string }).message);
    expect(notFound.size).toBe(1);
    expect(Array.from(notFound)[0]).toBe('Archived project not found.');

    const scope = await api('POST', '/genapi/projects/' + archTargetId + '/restore', {}, readerKey.key);
    expect(scope.status).toBe(403);
    expect((scope.body as { message: string }).message).toBe('The API key does not grant the required scope.');

    const restores = await prisma.auditEvent.count({ where: { action: 'project.restore' } });
    expect(restores).toBe(0);
    expect(await auditCount()).toBe(before);
  });

  it('tenant-bounds every write to the key organization', async () => {
    const before = await auditCount();

    const hers = await api(
      'POST',
      '/genapi/workspaces/' + foreignWorkspaceId + '/projects',
      { name: 'Iris Keyed Project ' + runId },
      irisWriterKey.key,
    );
    expect(hers.status).toBe(201);
    const hersRow = hers.body as { id: string; workspaceId: string; ownerId: string };
    expect(hersRow.workspaceId).toBe(foreignWorkspaceId);
    expect(hersRow.ownerId).toBe(iris.userId);

    const hankList = await api('GET', '/genapi/workspaces/' + workspaceAId + '/projects', undefined, readerKey.key);
    expect(hankList.status).toBe(200);
    const hankIds = new Set((hankList.body as unknown as Array<{ id: string }>).map((r) => r.id));
    expect(hankIds.has(hersRow.id)).toBe(false);

    const foreignCreate = await api(
      'POST',
      '/genapi/workspaces/' + foreignWorkspaceId + '/projects',
      { name: 'Hank Foreign Try ' + runId },
      writerKey.key,
    );
    expect(foreignCreate.status).toBe(404);
    expect((foreignCreate.body as { message: string }).message).toBe('Workspace not found.');

    const irisOnHankUpdate = await api('POST', '/genapi/projects/' + updateTargetId + '/update', { name: 'Iris Hijack ' + runId }, irisWriterKey.key);
    expect(irisOnHankUpdate.status).toBe(404);
    expect((irisOnHankUpdate.body as { message: string }).message).toBe('Project not found.');
    const irisOnHankArchive = await api('POST', '/genapi/projects/' + updateTargetId + '/archive', {}, irisWriterKey.key);
    expect(irisOnHankArchive.status).toBe(404);
    expect((irisOnHankArchive.body as { message: string }).message).toBe('Project not found.');
    const irisOnHankRestore = await api('POST', '/genapi/projects/' + archTargetId + '/restore', {}, irisWriterKey.key);
    expect(irisOnHankRestore.status).toBe(404);
    expect((irisOnHankRestore.body as { message: string }).message).toBe('Archived project not found.');

    const stored = await prisma.project.findUnique({ where: { id: updateTargetId }, select: { status: true } });
    expect(stored?.status).toBe('ACTIVE');
    expect(await auditCount()).toBe(before);
  });

  it('separates WRITE_PROJECTS from every other scope', async () => {
    const before = await auditCount();
    const messages = new Set<string>();
    const attempts: Array<[KeyContext, string, unknown]> = [
      [orgWriterKey, '/genapi/workspaces/' + workspaceAId + '/projects', { name: 'Scope Try ' + runId }],
      [orgWriterKey, '/genapi/projects/' + updateTargetId + '/update', { name: 'Scope Edit ' + runId }],
      [orgWriterKey, '/genapi/projects/' + updateTargetId + '/archive', {}],
      [orgWriterKey, '/genapi/projects/' + archTargetId + '/restore', {}],
      [readerKey, '/genapi/workspaces/' + workspaceAId + '/projects', { name: 'Scope Try ' + runId }],
      [readerKey, '/genapi/projects/' + updateTargetId + '/update', { name: 'Scope Edit ' + runId }],
      [readerKey, '/genapi/projects/' + updateTargetId + '/archive', {}],
      [readerKey, '/genapi/projects/' + archTargetId + '/restore', {}],
      [appWriterKey, '/genapi/workspaces/' + workspaceAId + '/projects', { name: 'Scope Try ' + runId }],
      [appWriterKey, '/genapi/projects/' + updateTargetId + '/update', { name: 'Scope Edit ' + runId }],
      [appWriterKey, '/genapi/projects/' + updateTargetId + '/archive', {}],
      [appWriterKey, '/genapi/projects/' + archTargetId + '/restore', {}],
    ];
    for (const [keyContext, path, body] of attempts) {
      const refused = await api('POST', path, body, keyContext.key);
      expect(refused.status).toBe(403);
      messages.add((refused.body as { message: string }).message);
    }
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('The API key does not grant the required scope.');
    expect(await auditCount()).toBe(before);
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
      '/genapi/workspaces/' + workspaceAId + '/projects',
      { name: 'Revoked Try ' + runId },
      revokedKey.key,
    );
    expect(revokedCreate.status).toBe(401);
    expect((revokedCreate.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const revokedArchive = await api('POST', '/genapi/projects/' + updateTargetId + '/archive', {}, revokedKey.key);
    expect(revokedArchive.status).toBe(401);
    expect((revokedArchive.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredCreate = await api(
      'POST',
      '/genapi/workspaces/' + workspaceAId + '/projects',
      { name: 'Expired Try ' + runId },
      shortLivedKey.key,
    );
    expect(expiredCreate.status).toBe(401);
    expect((expiredCreate.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const expiredUpdate = await api('POST', '/genapi/projects/' + updateTargetId + '/update', { description: 'Expired edit.' }, shortLivedKey.key);
    expect(expiredUpdate.status).toBe(401);
    expect((expiredUpdate.body as { message: string }).message).toBe('API key is invalid, expired, or revoked.');

    const anonymous = await api('POST', '/genapi/workspaces/' + workspaceAId + '/projects', { name: 'Anonymous Try ' + runId });
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { message: string }).message).toBe('A valid GENESIS API key is required.');
  });

  it('answers honestly when the key creator no longer exists', async () => {
    const jack = await registerUser('jack');
    const jackOrgs = await api('GET', '/organizations', undefined, jack.tokens.accessToken);
    expect(jackOrgs.status).toBe(200);
    jackOrgId = (jackOrgs.body as unknown as Array<{ id: string }>)[0].id;
    await prisma.membership.create({
      data: { userId: jack.userId, organizationId, role: 'ADMIN' },
    });
    jackKey = await createKey(jack.tokens.accessToken, organizationId, 'Jack Project Writer', ['READ_PROJECTS', 'WRITE_PROJECTS']);

    await prisma.user.delete({ where: { id: jack.userId } });

    const rowsBefore = await projectRowsInOrganization();
    const refusedCreate = await api(
      'POST',
      '/genapi/workspaces/' + workspaceAId + '/projects',
      { name: 'Orphan Try ' + runId },
      jackKey.key,
    );
    expect(refusedCreate.status).toBe(409);
    expect((refusedCreate.body as { message: string }).message).toBe('The key creator no longer exists.');
    expect(await projectRowsInOrganization()).toBe(rowsBefore);

    const stillUsableUpdate = await api(
      'POST',
      '/genapi/projects/' + updateTargetId + '/update',
      { description: 'Orphan key update.' },
      jackKey.key,
    );
    expect(stillUsableUpdate.status).toBe(201);

    // The orphan key still restores: the landed row records honest null
    // attribution because the creator is gone, never a fake owner.
    const orphanRestore = await api('POST', '/genapi/projects/' + archTargetId + '/restore', {}, jackKey.key);
    expect(orphanRestore.status).toBe(201);
    const rows = await prisma.auditEvent.findMany({
      where: { action: 'project.restore', resourceId: archTargetId },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].actorUserId).toBeNull();
    expect(rows[0].organizationId).toBe(organizationId);
    const metadata = rows[0].metadata as Record<string, unknown>;
    expect(metadata.via).toBe('genapi');
    expect(metadata.apiKeyId).toBe(jackKey.id);
    expect(metadata.apiKeyName).toBe('Jack Project Writer');
  });

  it('race: keyed archive against keyed update', async () => {
    const seeded = await api(
      'POST',
      '/workspaces/' + workspaceAId + '/projects',
      { name: 'Race Archive Update ' + runId },
      hank.tokens.accessToken,
    );
    expect(seeded.status).toBe(201);
    const raceId = (seeded.body as { id: string }).id;
    const seedName = 'Race Archive Update ' + runId;

    const raced = await Promise.all([
      api('POST', '/genapi/projects/' + raceId + '/archive', {}, writerKey.key),
      api('POST', '/genapi/projects/' + raceId + '/update', { name: 'Race Update Name ' + runId }, writerKey.key),
    ]);
    expect(raced[0].status).toBe(201);
    expect([201, 404]).toContain(raced[1].status);

    const stored = await prisma.project.findUnique({
      where: { id: raceId },
      select: { status: true, name: true },
    });
    expect(stored?.status).toBe('ARCHIVED');
    expect([seedName, 'Race Update Name ' + runId]).toContain(stored?.name);
  });

  it('race: keyed restore against keyed archive', async () => {
    const seeded = await api(
      'POST',
      '/workspaces/' + workspaceAId + '/projects',
      { name: 'Race Restore Archive ' + runId },
      hank.tokens.accessToken,
    );
    expect(seeded.status).toBe(201);
    const raceId = (seeded.body as { id: string }).id;

    const raced = await Promise.all([
      api('POST', '/genapi/projects/' + raceId + '/archive', {}, writerKey.key),
      api('POST', '/genapi/projects/' + raceId + '/restore', {}, writerKey.key),
    ]);
    expect(raced[0].status).toBe(201);
    expect([201, 404]).toContain(raced[1].status);

    const stored = await prisma.project.findUnique({ where: { id: raceId }, select: { status: true } });
    const restoreRows = await prisma.auditEvent.count({
      where: { action: 'project.restore', resourceId: raceId },
    });
    if (raced[1].status === 201) {
      expect(stored?.status).toBe('ACTIVE');
      expect(restoreRows).toBe(1);
    } else {
      expect(stored?.status).toBe('ARCHIVED');
      expect(restoreRows).toBe(0);
    }
  });

  it('race: double-tapped restore ends exactly one way', async () => {
    const seeded = await api(
      'POST',
      '/workspaces/' + workspaceAId + '/projects',
      { name: 'Race Restore Double ' + runId },
      hank.tokens.accessToken,
    );
    expect(seeded.status).toBe(201);
    const raceId = (seeded.body as { id: string }).id;

    const archived = await api('POST', '/genapi/projects/' + raceId + '/archive', {}, writerKey.key);
    expect(archived.status).toBe(201);

    const restore = () => api('POST', '/genapi/projects/' + raceId + '/restore', {}, writerKey.key);
    const raced = await Promise.all([restore(), restore()]);
    expect(raced.map((r) => r.status).sort()).toEqual([201, 404]);

    const stored = await prisma.project.findUnique({ where: { id: raceId }, select: { status: true } });
    expect(stored?.status).toBe('ACTIVE');
    const rows = await prisma.auditEvent.findMany({
      where: { action: 'project.restore', resourceId: raceId },
    });
    expect(rows.length).toBe(1);
    const metadata = rows[0].metadata as Record<string, unknown>;
    expect(metadata.via).toBe('genapi');
    expect(metadata.apiKeyId).toBe(writerKey.id);
  });

  it('race: keyed archive against JWT archive', async () => {
    const seeded = await api(
      'POST',
      '/workspaces/' + workspaceAId + '/projects',
      { name: 'Race Cross Archive ' + runId },
      hank.tokens.accessToken,
    );
    expect(seeded.status).toBe(201);
    const raceId = (seeded.body as { id: string }).id;

    const raced = await Promise.all([
      api('POST', '/genapi/projects/' + raceId + '/archive', {}, writerKey.key),
      api('POST', '/projects/' + raceId + '/archive', {}, hank.tokens.accessToken),
    ]);
    // Idempotent archive: both may land or the second may miss the ACTIVE
    // window. Never a server error, and the final state is archived.
    expect(raced.every((r) => [201, 404].includes(r.status))).toBe(true);
    expect(raced.some((r) => r.status === 201)).toBe(true);

    const stored = await prisma.project.findUnique({ where: { id: raceId }, select: { status: true } });
    expect(stored?.status).toBe('ARCHIVED');
    const restoreRows = await prisma.auditEvent.count({
      where: { action: 'project.restore', resourceId: raceId },
    });
    expect(restoreRows).toBe(0);
  });
});
