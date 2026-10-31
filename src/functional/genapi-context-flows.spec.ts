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

suite('genapi key-authenticated context flows (real app, real database)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let baseUrl: string;
  let hank: UserContext;
  let iris: UserContext;
  let projectIdA: string;
  let applicationIdA: string;
  let applicationIdB: string;
  let organizationIdA: string;
  let conversationIdA: string;
  let conversationIdB: string;
  let foreignConversationId: string;
  let messageIds: string[];
  let messageCursor: string;
  let referenceIdA1: string;
  let referenceIdA2: string;
  let foreignReferenceId: string;
  let readerKey: string;
  let writerOnlyKey: string;
  let irisWriterKey: string;
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
    const email = 'genesis-context-' + name + '-' + runId + '@example.com';
    const response = await api('POST', '/auth/register', {
      email,
      password: 'genapi-context-test-password-123',
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

  const createConversation = async (owner: UserContext, applicationId: string, title: string) => {
    const conversation = await api(
      'POST',
      '/applications/' + applicationId + '/conversations',
      { title },
      owner.tokens.accessToken,
    );
    expect(conversation.status).toBe(201);
    return conversation.body as { id: string };
  };

  const addMessage = async (owner: UserContext, conversationId: string, content: string) => {
    const message = await api(
      'POST',
      '/conversations/' + conversationId + '/messages',
      { content },
      owner.tokens.accessToken,
    );
    expect(message.status).toBe(201);
    return message.body as { id: string; createdAt: string };
  };

  const createReference = async (owner: UserContext, applicationId: string, title: string, content: string) => {
    const reference = await api(
      'POST',
      '/applications/' + applicationId + '/references',
      { title, kind: "SPEC", content },
      owner.tokens.accessToken,
    );
    expect(reference.status).toBe(201);
    return reference.body as { id: string };
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

  it('seeds two tenants, conversations, messages, references, and keys with distinct scopes', async () => {
    hank = await registerUser('hank');
    iris = await registerUser('iris');

    const tenantA = await seedTenant(hank, 'Genapi Context Project', 'Genapi Context App');
    projectIdA = tenantA.projectId;
    applicationIdA = tenantA.applicationId;
    organizationIdA = tenantA.organizationId;
    const tenantB = await seedTenant(iris, 'Iris Context Project', 'Iris Context App');
    applicationIdB = tenantB.applicationId;

    const chatOne = await createConversation(hank, applicationIdA, 'Chat One');
    conversationIdA = chatOne.id;
    messageIds = [];
    const first = await addMessage(hank, conversationIdA, 'First message about the landing page.');
    messageIds.push(first.id);
    const second = await addMessage(hank, conversationIdA, 'Second message about the contact form.');
    messageIds.push(second.id);
    const third = await addMessage(hank, conversationIdA, 'Third message about honest validation.');
    messageIds.push(third.id);
    messageCursor = third.createdAt;

    const chatTwo = await createConversation(hank, applicationIdA, 'Chat Two');
    conversationIdB = chatTwo.id;
    await addMessage(hank, conversationIdB, 'A single message in the second conversation.');

    const foreignChat = await createConversation(iris, applicationIdB, 'Iris Chat');
    foreignConversationId = foreignChat.id;
    await addMessage(iris, foreignConversationId, 'A message that belongs to another tenant.');

    const refOne = await createReference(hank, applicationIdA, 'Landing Spec', 'The landing page needs a hero and honest validation.');
    referenceIdA1 = refOne.id;
    const refTwo = await createReference(hank, applicationIdA, 'Transcript', 'A discovery call transcript with three open questions.');
    referenceIdA2 = refTwo.id;

    const foreignRef = await createReference(iris, applicationIdB, 'Iris Spec', 'A reference that belongs to another tenant.');
    foreignReferenceId = foreignRef.id;

    const reader = await createKey(hank.tokens.accessToken, organizationIdA, 'reader', ['READ_APPLICATIONS']);
    expect(reader.status).toBe(201);
    readerKey = (reader.body as { key: string }).key;

    const writerOnly = await createKey(hank.tokens.accessToken, organizationIdA, 'writer-only', ['WRITE_APPLICATIONS']);
    expect(writerOnly.status).toBe(201);
    writerOnlyKey = (writerOnly.body as { key: string }).key;

    const irisWriter = await createKey(iris.tokens.accessToken, tenantB.organizationId, 'iris-writer', ['READ_APPLICATIONS', 'WRITE_APPLICATIONS']);
    expect(irisWriter.status).toBe(201);
    irisWriterKey = (irisWriter.body as { key: string }).key;
  });

  it('lists conversations for a key with parity against the JWT surface', async () => {
    const listed = await genapiGet('applications/' + applicationIdA + '/conversations', readerKey);
    expect(listed.status).toBe(200);
    const items = listed.body as unknown as Array<{ id: string; title: string; archivedAt: string | null; _count: { messages: number } }>;
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.id)).toEqual([conversationIdB, conversationIdA]);
    const chatTwoRow = items.find((item) => item.id === conversationIdB);
    expect(chatTwoRow ? chatTwoRow._count.messages : 0).toBe(1);
    const chatOneRow = items.find((item) => item.id === conversationIdA);
    expect(chatOneRow ? chatOneRow._count.messages : 0).toBe(3);
    expect(items.every((item) => item.archivedAt === null)).toBe(true);

    const jwtListed = await api('GET', '/applications/' + applicationIdA + '/conversations', undefined, hank.tokens.accessToken);
    expect(jwtListed.status).toBe(200);
    expect(listed.body).toEqual(jwtListed.body);
  });

  it('lists messages for a key with parity and oldest-first order', async () => {
    const listed = await genapiGet('applications/' + applicationIdA + '/conversations/' + conversationIdA + '/messages', readerKey);
    expect(listed.status).toBe(200);
    const items = listed.body as unknown as Array<{ id: string; role: string; content: string }>;
    expect(items.map((item) => item.id)).toEqual(messageIds);
    expect(items.every((item) => item.role === 'USER')).toBe(true);

    const jwtListed = await api('GET', '/conversations/' + conversationIdA + '/messages', undefined, hank.tokens.accessToken);
    expect(jwtListed.status).toBe(200);
    expect(listed.body).toEqual(jwtListed.body);
  });

  it('honors the take window on the key surface exactly like the JWT surface', async () => {
    const taken = await genapiGet('applications/' + applicationIdA + '/conversations/' + conversationIdA + '/messages?take=2', readerKey);
    expect(taken.status).toBe(200);
    const items = taken.body as unknown as Array<{ id: string }>;
    expect(items.map((item) => item.id)).toEqual([messageIds[1], messageIds[2]]);

    const jwtTaken = await api('GET', '/conversations/' + conversationIdA + '/messages?take=2', undefined, hank.tokens.accessToken);
    expect(jwtTaken.status).toBe(200);
    expect(taken.body).toEqual(jwtTaken.body);

    const rawList = ['take=0', 'take=101', 'take=abc'];
    for (const raw of rawList) {
      const refused = await genapiGet('applications/' + applicationIdA + '/conversations/' + conversationIdA + '/messages?' + raw, readerKey);
      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toBe('take must be an integer between 1 and 100.');
      const jwtRefused = await api('GET', '/conversations/' + conversationIdA + '/messages?' + raw, undefined, hank.tokens.accessToken);
      expect(jwtRefused.status).toBe(400);
      expect((jwtRefused.body as { message: string }).message).toBe('take must be an integer between 1 and 100.');
    }
  });

  it('walks the before cursor on the key surface with parity and named refusal', async () => {
    const walked = await genapiGet('applications/' + applicationIdA + '/conversations/' + conversationIdA + '/messages?before=' + encodeURIComponent(messageCursor), readerKey);
    expect(walked.status).toBe(200);
    const items = walked.body as unknown as Array<{ id: string }>;
    expect(items.map((item) => item.id)).toEqual([messageIds[0], messageIds[1]]);

    const jwtWalked = await api('GET', '/conversations/' + conversationIdA + '/messages?before=' + encodeURIComponent(messageCursor), undefined, hank.tokens.accessToken);
    expect(jwtWalked.status).toBe(200);
    expect(walked.body).toEqual(jwtWalked.body);

    const refused = await genapiGet('applications/' + applicationIdA + '/conversations/' + conversationIdA + '/messages?before=not-a-date', readerKey);
    expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toBe('Invalid message pagination cursor.');
    const jwtRefused = await api('GET', '/conversations/' + conversationIdA + '/messages?before=not-a-date', undefined, hank.tokens.accessToken);
    expect(jwtRefused.status).toBe(400);
    expect((jwtRefused.body as { message: string }).message).toBe('Invalid message pagination cursor.');
  });

  it('lists references for a key with parity against the JWT surface', async () => {
    const listed = await genapiGet('applications/' + applicationIdA + '/references', readerKey);
    expect(listed.status).toBe(200);
    const items = listed.body as unknown as Array<{ id: string; title: string; content: string; kind: string }>;
    expect(items.map((item) => item.id)).toEqual([referenceIdA2, referenceIdA1]);
    expect(items.every((item) => item.kind === 'SPEC')).toBe(true);
    expect(items.every((item) => item.content.length > 0)).toBe(true);

    const jwtListed = await api('GET', '/applications/' + applicationIdA + '/references', undefined, hank.tokens.accessToken);
    expect(jwtListed.status).toBe(200);
    expect(listed.body).toEqual(jwtListed.body);
  });

  it('inspects a reference for a key with parity against the JWT surface', async () => {
    const inspected = await genapiGet('applications/' + applicationIdA + '/references/' + referenceIdA1, readerKey);
    expect(inspected.status).toBe(200);
    const reference = inspected.body as { id: string; title: string; content: string };
    expect(reference.id).toBe(referenceIdA1);
    expect(reference.title).toBe('Landing Spec');
    expect(reference.content).toContain('honest validation');

    const jwtInspected = await api('GET', '/applications/' + applicationIdA + '/references/' + referenceIdA1, undefined, hank.tokens.accessToken);
    expect(jwtInspected.status).toBe(200);
    expect(inspected.body).toEqual(jwtInspected.body);
  });

  it('keeps foreign and unknown references behind the same uniform 404', async () => {
    const probes = [
      ['applications/' + applicationIdA + '/references/unknown-reference-id', readerKey],
      ['applications/' + applicationIdA + '/references/' + foreignReferenceId, readerKey],
      ['applications/' + applicationIdB + '/references/' + referenceIdA1, irisWriterKey],
    ] as Array<[string, string]>;
    const messages = new Set<string>();
    for (const [path, key] of probes) {
      const refused = await genapiGet(path, key);
      expect(refused.status).toBe(404);
      messages.add(String((refused.body as { message?: string }).message));
    }
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Reference not found.');

    const foreignKey = await genapiGet('applications/' + applicationIdA + '/references/' + referenceIdA1, irisWriterKey);
    expect(foreignKey.status).toBe(404);
  });

  it('keeps foreign and unknown conversations behind the same uniform 404', async () => {
    const probes = [
      ['applications/' + applicationIdA + '/conversations/unknown-conversation-id/messages', readerKey],
      ['applications/' + applicationIdA + '/conversations/' + foreignConversationId + '/messages', readerKey],
      ['applications/' + applicationIdB + '/conversations/' + conversationIdA + '/messages', irisWriterKey],
    ] as Array<[string, string]>;
    const messages = new Set<string>();
    for (const [path, key] of probes) {
      const refused = await genapiGet(path, key);
      expect(refused.status).toBe(404);
      messages.add(String((refused.body as { message?: string }).message));
    }
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Conversation not found.');

    const foreignKey = await genapiGet('applications/' + applicationIdA + '/conversations/' + conversationIdA + '/messages', irisWriterKey);
    expect(foreignKey.status).toBe(404);
  });

  it('keeps conversation and reference lists tenant-bounded behind a uniform 404', async () => {
    const probes = [
      ['applications/unknown-application-id/conversations', readerKey],
      ['applications/' + applicationIdB + '/conversations', readerKey],
      ['applications/' + applicationIdA + '/conversations', irisWriterKey],
      ['applications/unknown-application-id/references', readerKey],
      ['applications/' + applicationIdB + '/references', readerKey],
      ['applications/' + applicationIdA + '/references', irisWriterKey],
    ] as Array<[string, string]>;
    const statuses: number[] = [];
    const messages = new Set<string>();
    for (const [path, key] of probes) {
      const refused = await genapiGet(path, key);
      statuses.push(refused.status);
      messages.add(String((refused.body as { message?: string }).message));
    }
    expect(statuses.every((status) => status === 404)).toBe(true);
    expect(messages.size).toBe(1);
    expect(Array.from(messages)[0]).toBe('Application not found.');
  });

  it('refuses a write-only key on every context read endpoint', async () => {
    const paths = [
      'applications/' + applicationIdA + '/conversations',
      'applications/' + applicationIdA + '/conversations/' + conversationIdA + '/messages',
      'applications/' + applicationIdA + '/references',
      'applications/' + applicationIdA + '/references/' + referenceIdA1,
    ];
    for (const path of paths) {
      const refused = await genapiGet(path, writerOnlyKey);
      expect(refused.status).toBe(403);
    }
  });

  it('races a keyed message list against a JWT message append without ever surfacing a 500', async () => {
    const raced = await Promise.all([
      genapiGet('applications/' + applicationIdA + '/conversations/' + conversationIdB + '/messages', readerKey),
      api('POST', '/conversations/' + conversationIdB + '/messages', { content: 'A message racing the keyed reader.' }, hank.tokens.accessToken),
    ]);
    expect(raced[0].status).toBe(200);
    const snapshot = raced[0].body as unknown as Array<{ id: string }>;
    expect(snapshot.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.length).toBeLessThanOrEqual(2);
    expect(raced[1].status).toBe(201);

    const after = await genapiGet('applications/' + applicationIdA + '/conversations/' + conversationIdB + '/messages', readerKey);
    expect(after.status).toBe(200);
    const items = after.body as unknown as Array<{ id: string; content: string }>;
    expect(items).toHaveLength(2);
    expect(items[items.length - 1].content).toBe('A message racing the keyed reader.');
  });

  it('keeps keyed context reads working on an archived application while writes stay blocked', async () => {
    const archived = await api(
      'POST',
      '/projects/' + projectIdA + '/applications/' + applicationIdA + '/archive',
      {},
      hank.tokens.accessToken,
    );
    expect(archived.status).toBe(201);

    const conversations = await genapiGet('applications/' + applicationIdA + '/conversations', readerKey);
    expect(conversations.status).toBe(200);

    const messages = await genapiGet('applications/' + applicationIdA + '/conversations/' + conversationIdA + '/messages', readerKey);
    expect(messages.status).toBe(200);

    const references = await genapiGet('applications/' + applicationIdA + '/references', readerKey);
    expect(references.status).toBe(200);

    const reference = await genapiGet('applications/' + applicationIdA + '/references/' + referenceIdA1, readerKey);
    expect(reference.status).toBe(200);

// Writes stay blocked on the archived application, matching the honest
// read-write split of the JWT surface.
    const write = await api('POST', '/conversations/' + conversationIdA + '/messages', { content: 'Should be refused.' }, hank.tokens.accessToken);
    expect(write.status).toBe(404);
  });

  it('stops a revoked key instantly on context reads', async () => {
    const created = await createKey(hank.tokens.accessToken, organizationIdA, 'doomed', ['READ_APPLICATIONS']);
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

    const conversations = await genapiGet('applications/' + applicationIdA + '/conversations', doomedKey);
    expect(conversations.status).toBe(401);
    const messages = await genapiGet('applications/' + applicationIdA + '/conversations/' + conversationIdA + '/messages', doomedKey);
    expect(messages.status).toBe(401);
    const references = await genapiGet('applications/' + applicationIdA + '/references', doomedKey);
    expect(references.status).toBe(401);
    const reference = await genapiGet('applications/' + applicationIdA + '/references/' + referenceIdA1, doomedKey);
    expect(reference.status).toBe(401);
  });

  it('honors expiry on the context surface', async () => {
    const expiresAt = new Date(Date.now() + 2000).toISOString();
    const created = await createKey(
      hank.tokens.accessToken,
      organizationIdA,
      'fleeting',
      ['READ_APPLICATIONS'],
      expiresAt,
    );
    expect(created.status).toBe(201);
    const fleetingKey = (created.body as { key: string }).key;

    const before = await genapiGet('applications/' + applicationIdA + '/conversations', fleetingKey);
    expect(before.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const afterConversations = await genapiGet('applications/' + applicationIdA + '/conversations', fleetingKey);
    expect(afterConversations.status).toBe(401);
    const afterReference = await genapiGet('applications/' + applicationIdA + '/references/' + referenceIdA1, fleetingKey);
    expect(afterReference.status).toBe(401);
  });

  it('rejects missing credentials with a uniform 401 on every context endpoint', async () => {
    const reads = [
      'applications/' + applicationIdA + '/conversations',
      'applications/' + applicationIdA + '/conversations/' + conversationIdA + '/messages',
      'applications/' + applicationIdA + '/references',
      'applications/' + applicationIdA + '/references/' + referenceIdA1,
    ];
    for (const path of reads) {
      const refused = await genapiGet(path, undefined);
      expect(refused.status).toBe(401);
    }
  });
});