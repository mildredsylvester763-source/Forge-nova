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
 * Keyed membership lifecycle writes over the real app and the real
 * CI PostgreSQL. Grounded in the GitHub organization members REST
 * surface: managing membership runs behind the Members organization
 * write permission, ownership changes are owner-only actions, and a
 * token never grants more access than its owner. Keys are minted only
 * by organization admins, so a WRITE_ORGANIZATION key is an
 * admin-delegated membership write bounded to the key organization,
 * every landed write stamps exactly one audit row via genapi, and
 * racing writes end exactly one clean way.
 */
suite('GENESIS keyed membership lifecycle flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let hank: UserContext;
  let sam: UserContext;
  let iris: UserContext;
  let uly: UserContext;
  let tess: UserContext;
  let organizationId = '';
  let foreignOrganizationId = '';
  let hankMembershipId = '';
  let samMembershipId = '';
  let ulyMembershipId = '';
  let ulyForeignMembershipId = '';
  let tessMembershipId = '';
  let writerKey: KeyContext;
  let samKey: KeyContext;
  let readerKey: KeyContext;
  let appWriterKey: KeyContext;
  let shortLivedKey: KeyContext;
  let revokedKey: KeyContext;
  let irisWriterKey: KeyContext;
  const createdUserIds: string[] = [];
  const runId = Math.random().toString(36).slice(2, 10);
  const password = 'gmw-membership-write-password-123';

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
    const email = 'genesis-gmw-' + name + '-' + runId + '@example.com';
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

  const memberDirectory = async (): Promise<Array<{ id: string; role: string; user: { email: string } }>> => {
    const listing = await api('GET', '/genapi/members', undefined, writerKey.key);
    expect(listing.status).toBe(200);
    return listing.body as unknown as Array<{ id: string; role: string; user: { email: string } }>;
  };

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
    const orgIds = [organizationId, foreignOrganizationId].filter((id) => id !== '');
    if (orgIds.length > 0) {
      await prisma.auditEvent.deleteMany({ where: { organizationId: { in: orgIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.organization.deleteMany({
        where: { memberships: { some: { userId: { in: createdUserIds } } } },
      });
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it('seeds two organizations, a second member, and scoped keys', async () => {
    hank = await registerUser('hank');
    sam = await registerUser('sam');
    iris = await registerUser('iris');
    uly = await registerUser('uly');
    tess = await registerUser('tess');

    const hankOrgs = await api('GET', '/organizations', undefined, hank.tokens.accessToken);
    expect(hankOrgs.status).toBe(200);
    organizationId = (hankOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const irisOrgs = await api('GET', '/organizations', undefined, iris.tokens.accessToken);
    expect(irisOrgs.status).toBe(200);
    foreignOrganizationId = (irisOrgs.body as unknown as Array<{ id: string }>)[0].id;

    const addSam = await api(
      'POST',
      '/organizations/' + organizationId + '/members',
      { email: sam.email, role: 'DEVELOPER' },
      hank.tokens.accessToken,
    );
    expect(addSam.status).toBe(201);
    samMembershipId = (addSam.body as { id: string }).id;

    // Promote sam just long enough to mint a key whose creator is not
    // the owner, then demote: the ownership gate must refuse that key
    // honestly later.
    const promote = await api(
      'PATCH',
      '/organizations/' + organizationId + '/members/' + samMembershipId,
      { role: 'ADMIN' },
      hank.tokens.accessToken,
    );
    expect(promote.status).toBe(200);
    samKey = await createKey(
      sam.tokens.accessToken,
      organizationId,
      'Sam Machine Key',
      ['READ_ORGANIZATION', 'WRITE_ORGANIZATION'],
    );
    const demote = await api(
      'PATCH',
      '/organizations/' + organizationId + '/members/' + samMembershipId,
      { role: 'DEVELOPER' },
      hank.tokens.accessToken,
    );
    expect(demote.status).toBe(200);

    const members = await api(
      'GET',
      '/organizations/' + organizationId + '/members',
      undefined,
      hank.tokens.accessToken,
    );
    expect(members.status).toBe(200);
    const rows = members.body as unknown as Array<{ id: string; role: string; user: { email: string } }>;
    hankMembershipId = rows.find((r) => r.user.email === hank.email)?.id ?? '';
    expect(hankMembershipId).not.toBe('');
    expect(rows.find((r) => r.user.email === sam.email)?.role).toBe('DEVELOPER');

    writerKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Org Writer',
      ['READ_ORGANIZATION', 'WRITE_ORGANIZATION'],
    );
    readerKey = await createKey(hank.tokens.accessToken, organizationId, 'Org Reader', ['READ_ORGANIZATION']);
    appWriterKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'App Writer',
      ['READ_APPLICATIONS', 'WRITE_APPLICATIONS'],
    );
    shortLivedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Short Lived',
      ['WRITE_ORGANIZATION'],
      new Date(Date.now() + 2000).toISOString(),
    );
    revokedKey = await createKey(
      hank.tokens.accessToken,
      organizationId,
      'Revoked',
      ['WRITE_ORGANIZATION'],
    );
    irisWriterKey = await createKey(
      iris.tokens.accessToken,
      foreignOrganizationId,
      'Iris Machine Key',
      ['READ_ORGANIZATION', 'WRITE_ORGANIZATION'],
    );
  });

  it('keyed add mirrors the JWT add shape and lands exactly one attributed audit row', async () => {
    const before = await auditCount();

    const added = await api('POST', '/genapi/members', { email: uly.email, role: 'DEVELOPER' }, writerKey.key);
    expect(added.status).toBe(201);
    const row = added.body as {
      id: string;
      organizationId: string;
      role: string;
      createdAt: string;
      user: { id: string; email: string; displayName: string };
    };
    expect(row.organizationId).toBe(organizationId);
    expect(row.role).toBe('DEVELOPER');
    expect(row.user.email).toBe(uly.email);
    expect(row.user.displayName).toBe('uly');
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'id', 'organizationId', 'role', 'user']);
    expect(Object.keys(row.user).sort()).toEqual(['displayName', 'email', 'id']);
    ulyMembershipId = row.id;

    const directory = await memberDirectory();
    const ulyRow = directory.find((r) => r.user.email === uly.email);
    expect(ulyRow?.id).toBe(ulyMembershipId);
    expect(ulyRow?.role).toBe('DEVELOPER');

    const trail = await prisma.auditEvent.findFirst({
      where: { organizationId, action: 'organization.member.add', resourceId: ulyMembershipId },
      select: { actorUserId: true, metadata: true, outcome: true, resourceType: true },
    });
    expect(trail).not.toBeNull();
    expect(trail?.actorUserId).toBe(hank.userId);
    expect(trail?.outcome).toBe('SUCCESS');
    expect(trail?.resourceType).toBe('membership');
    expect(trail?.metadata).toEqual({
      role: 'DEVELOPER',
      via: 'genapi',
      apiKeyId: writerKey.id,
      apiKeyName: 'Org Writer',
    });

    expect(await auditCount()).toBe(before + 1);
  });

  it('refuses owner assignment, unknown emails, and duplicates honestly', async () => {
    const before = await auditCount();

    const ownerAdd = await api(
      'POST',
      '/genapi/members',
      { email: uly.email, role: 'OWNER' },
      writerKey.key,
    );
    expect(ownerAdd.status).toBe(400);
    expect((ownerAdd.body as { message: string }).message).toBe(
      'Owner assignment requires the dedicated ownership-transfer workflow.',
    );

    const unknownAdd = await api(
      'POST',
      '/genapi/members',
      { email: 'gmw-ghost-' + runId + '@example.com', role: 'DEVELOPER' },
      writerKey.key,
    );
    expect(unknownAdd.status).toBe(404);
    expect((unknownAdd.body as { message: string }).message).toBe(
      'An active GENESIS account with this email was not found.',
    );

    const duplicate = await api(
      'POST',
      '/genapi/members',
      { email: uly.email, role: 'DEVELOPER' },
      writerKey.key,
    );
    expect(duplicate.status).toBe(409);
    expect((duplicate.body as { message: string }).message).toBe(
      'This account is already a member of the organization.',
    );

    expect(await auditCount()).toBe(before);
  });

  it('race: a JWT add and a keyed add of the same user end exactly one clean way', async () => {
    const before = await auditCount();

    const raced = await Promise.all([
      api(
        'POST',
        '/organizations/' + organizationId + '/members',
        { email: tess.email, role: 'DEVELOPER' },
        hank.tokens.accessToken,
      ),
      api('POST', '/genapi/members', { email: tess.email, role: 'DEVELOPER' }, writerKey.key),
    ]);
    const statuses = raced.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);

    const tessRows = await prisma.membership.findMany({
      where: { organizationId, user: { email: tess.email } },
      select: { id: true, role: true },
    });
    expect(tessRows.length).toBe(1);
    tessMembershipId = tessRows[0].id;

    const addTrail = await prisma.auditEvent.findMany({
      where: { organizationId, action: 'organization.member.add', resourceId: tessMembershipId },
      select: { id: true },
    });
    expect(addTrail.length).toBe(1);

    const directory = await memberDirectory();
    const tessRow = directory.find((r) => r.user.email === tess.email);
    expect(tessRow?.id).toBe(tessMembershipId);
    expect(tessRow?.role).toBe('DEVELOPER');

    expect(await auditCount()).toBe(before + 1);
  });

  it('keyed role change mirrors the JWT shape and stamps the acting key', async () => {
    const before = await auditCount();

    const changed = await api(
      'POST',
      '/genapi/members/' + tessMembershipId + '/update',
      { role: 'BILLING' },
      writerKey.key,
    );
    expect(changed.status).toBe(201);
    const row = changed.body as {
      id: string;
      organizationId: string;
      role: string;
      createdAt: string;
      updatedAt: string;
      user: { id: string; email: string; displayName: string };
    };
    expect(row.id).toBe(tessMembershipId);
    expect(row.organizationId).toBe(organizationId);
    expect(row.role).toBe('BILLING');
    expect(row.user.email).toBe(tess.email);
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'id', 'organizationId', 'role', 'updatedAt', 'user']);

    const trail = await prisma.auditEvent.findFirst({
      where: {
        organizationId,
        action: 'organization.member.role.change',
        resourceId: tessMembershipId,
      },
      select: { actorUserId: true, metadata: true, outcome: true },
    });
    expect(trail).not.toBeNull();
    expect(trail?.actorUserId).toBe(hank.userId);
    expect(trail?.outcome).toBe('SUCCESS');
    expect(trail?.metadata).toEqual({
      previousRole: 'DEVELOPER',
      newRole: 'BILLING',
      via: 'genapi',
      apiKeyId: writerKey.id,
      apiKeyName: 'Org Writer',
    });

    const ownerAttempt = await api(
      'POST',
      '/genapi/members/' + tessMembershipId + '/update',
      { role: 'OWNER' },
      writerKey.key,
    );
    expect(ownerAttempt.status).toBe(400);

    const unknownAttempt = await api(
      'POST',
      '/genapi/members/membership-gmw-unknown-' + runId + '/update',
      { role: 'VIEWER' },
      writerKey.key,
    );
    expect(unknownAttempt.status).toBe(404);
    expect((unknownAttempt.body as { message: string }).message).toBe('Membership not found.');

    expect(await auditCount()).toBe(before + 1);
  });

  it('protects the last owner and tenant-bounds role changes', async () => {
    const before = await auditCount();

    const ownerDemote = await api(
      'POST',
      '/genapi/members/' + hankMembershipId + '/update',
      { role: 'ADMIN' },
      writerKey.key,
    );
    expect(ownerDemote.status).toBe(400);
    expect((ownerDemote.body as { message: string }).message).toBe(
      'The organization must keep at least one owner.',
    );

    const foreignChange = await api(
      'POST',
      '/genapi/members/' + tessMembershipId + '/update',
      { role: 'VIEWER' },
      irisWriterKey.key,
    );
    expect(foreignChange.status).toBe(404);
    expect((foreignChange.body as { message: string }).message).toBe('Membership not found.');

    // The same foreign key DOES work inside its own organization, so the
    // 404 above is a tenant bound, not a broken key.
    const foreignAdd = await api(
      'POST',
      '/genapi/members',
      { email: uly.email, role: 'DEVELOPER' },
      irisWriterKey.key,
    );
    expect(foreignAdd.status).toBe(201);
    ulyForeignMembershipId = (foreignAdd.body as { id: string }).id;
    expect(ulyForeignMembershipId).not.toBe(ulyMembershipId);

    const foreignRoleChange = await api(
      'POST',
      '/genapi/members/' + ulyForeignMembershipId + '/update',
      { role: 'BILLING' },
      irisWriterKey.key,
    );
    expect(foreignRoleChange.status).toBe(201);

    expect(await auditCount()).toBe(before);
  });

  it('refuses ownership transfers honestly before any transfer lands', async () => {
    const before = await auditCount();

    const nonOwnerKey = await api(
      'POST',
      '/genapi/ownership-transfer',
      { memberId: samMembershipId },
      samKey.key,
    );
    expect(nonOwnerKey.status).toBe(403);
    expect((nonOwnerKey.body as { message: string }).message).toBe(
      'Only an owner can transfer ownership.',
    );

    const selfTransfer = await api(
      'POST',
      '/genapi/ownership-transfer',
      { memberId: hankMembershipId },
      writerKey.key,
    );
    expect(selfTransfer.status).toBe(400);
    expect((selfTransfer.body as { message: string }).message).toBe(
      'You already own this organization.',
    );

    const foreignTarget = await api(
      'POST',
      '/genapi/ownership-transfer',
      { memberId: ulyForeignMembershipId },
      writerKey.key,
    );
    expect(foreignTarget.status).toBe(404);
    expect((foreignTarget.body as { message: string }).message).toBe(
      'Target membership not found.',
    );

    const unknownTarget = await api(
      'POST',
      '/genapi/ownership-transfer',
      { memberId: 'membership-gmw-ghost-' + runId },
      writerKey.key,
    );
    expect(unknownTarget.status).toBe(404);
    expect((unknownTarget.body as { message: string }).message).toBe(
      'Target membership not found.',
    );

    expect(await auditCount()).toBe(before);
  });

  it('lands the keyed ownership transfer exactly once, then honors the token law', async () => {
    const before = await auditCount();

    const transfer = await api(
      'POST',
      '/genapi/ownership-transfer',
      { memberId: samMembershipId },
      writerKey.key,
    );
    expect(transfer.status).toBe(201);
    expect(transfer.body).toEqual({
      organizationId,
      previousOwnerId: hank.userId,
      newOwnerId: sam.userId,
    });

    const roles = await prisma.membership.findMany({
      where: { organizationId },
      select: { role: true, user: { select: { email: true } } },
    });
    expect(roles.find((r) => r.user.email === sam.email)?.role).toBe('OWNER');
    expect(roles.find((r) => r.user.email === hank.email)?.role).toBe('ADMIN');
    const ownerCount = await prisma.membership.count({
      where: { organizationId, role: 'OWNER' },
    });
    expect(ownerCount).toBe(1);

    const trail = await prisma.auditEvent.findFirst({
      where: {
        organizationId,
        action: 'organization.ownership.transfer',
        resourceId: samMembershipId,
      },
      select: { actorUserId: true, metadata: true, outcome: true },
    });
    expect(trail).not.toBeNull();
    expect(trail?.actorUserId).toBe(hank.userId);
    expect(trail?.outcome).toBe('SUCCESS');
    expect(trail?.metadata).toEqual({
      previousOwnerId: hank.userId,
      newOwnerId: sam.userId,
      via: 'genapi',
      apiKeyId: writerKey.id,
      apiKeyName: 'Org Writer',
    });

    expect(await auditCount()).toBe(before + 1);

    // The PAT law: the key creator lost OWNER, so the key lost the
    // capability. A second transfer must now refuse honestly.
    const afterDemotion = await api(
      'POST',
      '/genapi/ownership-transfer',
      { memberId: ulyMembershipId },
      writerKey.key,
    );
    expect(afterDemotion.status).toBe(403);
    expect((afterDemotion.body as { message: string }).message).toBe(
      'Only an owner can transfer ownership.',
    );
    expect(await auditCount()).toBe(before + 1);
  });

  it('protects owners from keyed removal and tenant-bounds removals', async () => {
    const before = await auditCount();

    const ownerRemoval = await api(
      'POST',
      '/genapi/members/' + samMembershipId + '/remove',
      undefined,
      writerKey.key,
    );
    expect(ownerRemoval.status).toBe(400);
    expect((ownerRemoval.body as { message: string }).message).toBe(
      'Owners cannot be removed directly. Transfer ownership first.',
    );

    const foreignRemoval = await api(
      'POST',
      '/genapi/members/' + ulyMembershipId + '/remove',
      undefined,
      irisWriterKey.key,
    );
    expect(foreignRemoval.status).toBe(404);
    expect((foreignRemoval.body as { message: string }).message).toBe('Membership not found.');

    const unknownRemoval = await api(
      'POST',
      '/genapi/members/membership-gmw-ghost-' + runId + '/remove',
      undefined,
      writerKey.key,
    );
    expect(unknownRemoval.status).toBe(404);
    expect((unknownRemoval.body as { message: string }).message).toBe('Membership not found.');

    expect(await auditCount()).toBe(before);
  });

  it('race: two keyed removals end exactly one clean way with one audit row', async () => {
    const before = await auditCount();

    const raced = await Promise.all([
      api('POST', '/genapi/members/' + tessMembershipId + '/remove', undefined, writerKey.key),
      api('POST', '/genapi/members/' + tessMembershipId + '/remove', undefined, writerKey.key),
    ]);
    const statuses = raced.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 404]);
    const winner = raced.find((r) => r.status === 201) as ApiResponse;
    expect(winner.body).toEqual({ removed: true, membershipId: tessMembershipId });

    const remaining = await prisma.membership.findMany({
      where: { organizationId, id: tessMembershipId },
      select: { id: true },
    });
    expect(remaining.length).toBe(0);

    const removeTrail = await prisma.auditEvent.findMany({
      where: { organizationId, action: 'organization.member.remove', resourceId: tessMembershipId },
      select: { metadata: true },
    });
    expect(removeTrail.length).toBe(1);
    expect(removeTrail[0].metadata).toEqual({
      removedUserId: tess.userId,
      role: 'BILLING',
      via: 'genapi',
      apiKeyId: writerKey.id,
      apiKeyName: 'Org Writer',
    });

    expect(await auditCount()).toBe(before + 1);
  });

  it('refuses wrong-scope keys with one identical message and zero side effects', async () => {
    const before = await auditCount();
    const directoryBefore = await memberDirectory();

    const scopeMessages = new Set<string>();
    const wrongAttempts = [
      ['POST', '/genapi/members', { email: uly.email, role: 'VIEWER' }],
      ['POST', '/genapi/members/' + ulyMembershipId + '/update', { role: 'VIEWER' }],
      ['POST', '/genapi/members/' + ulyMembershipId + '/remove', undefined],
      ['POST', '/genapi/ownership-transfer', { memberId: ulyMembershipId }],
    ] as const;
    for (const wrongKey of [readerKey, appWriterKey]) {
      for (const [method, path, body] of wrongAttempts) {
        const refused = await api(method, path, body, wrongKey.key);
        expect(refused.status).toBe(403);
        scopeMessages.add((refused.body as { message: string }).message);
      }
    }
    expect(scopeMessages.size).toBe(1);
    expect(Array.from(scopeMessages)[0]).toBe('The API key does not grant the required scope.');

    const directoryAfter = await memberDirectory();
    expect(directoryAfter).toEqual(directoryBefore);
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

    const revokedWrite = await api(
      'POST',
      '/genapi/members',
      { email: uly.email, role: 'VIEWER' },
      revokedKey.key,
    );
    expect(revokedWrite.status).toBe(401);
    expect((revokedWrite.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expiredWrite = await api(
      'POST',
      '/genapi/members',
      { email: uly.email, role: 'VIEWER' },
      shortLivedKey.key,
    );
    expect(expiredWrite.status).toBe(401);
    expect((expiredWrite.body as { message: string }).message).toBe(
      'API key is invalid, expired, or revoked.',
    );

    const anonymous = await api('POST', '/genapi/members', { email: uly.email, role: 'VIEWER' });
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { message: string }).message).toBe(
      'A valid GENESIS API key is required.',
    );

    const directory = await memberDirectory();
    const ulyRow = directory.find((r) => r.user.email === uly.email);
    expect(ulyRow?.role).toBe('DEVELOPER');
  });
});
