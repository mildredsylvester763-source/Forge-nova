import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthenticatedApiKey } from '../api-keys/api-key.guard';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { SecretScannerService } from '../security/secret-scanner.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { CreateMessageDto } from './dto/create-message.dto';

@Injectable()
export class ConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly secrets: SecretScannerService,
  ) {}

  /**
   * The one conversation-listing core shared by the JWT route and the
   * genapi key route: newest activity first, with honest message counts.
   * Archived conversations stay visible because their archivedAt stamp
   * is the honest signal - the key read surface mirrors that exactly.
   */
  private listConversationsForApplication(applicationId: string) {
    return this.prisma.conversation.findMany({
      where: { applicationId },
      select: {
        id: true,
        applicationId: true,
        title: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async listForApplication(userId: string, applicationId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    return this.listConversationsForApplication(applicationId);
  }

  /**
   * Key-authenticated conversation listing. Grounded in the GitHub
   * issue-comment listing: reading needs only read access, and foreign
   * or missing applications answer the same uniform 404. Reads stay
   * possible on archived applications; there is no audit row for reads.
   */
  async listForKey(key: AuthenticatedApiKey, applicationId: string) {
    await this.access.requireReadableApplicationInOrganization(key.organizationId, applicationId);
    return this.listConversationsForApplication(applicationId);
  }

  async create(userId: string, applicationId: string, dto: CreateConversationDto) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    return this.prisma.conversation.create({
      data: {
        applicationId,
        title: dto.title?.trim() || null,
      },
      select: {
        id: true,
        applicationId: true,
        title: true,
        archivedAt: true,
        createdAt: true,
      },
    });
  }

  /**
   * Key-authenticated conversation create. Grounded in the GitHub
   * issue create and the OpenAI thread create: a token with write
   * permission may create the thread under a specific parent, and an
   * empty thread is an honest create. The writable tenant bound
   * refuses foreign, missing, and archived applications with the
   * same uniform 404 the keyed writes already answer, and the create
   * mirrors the JWT create exactly - same optional title trim law,
   * same response shape, and no audit row, because the JWT create
   * writes none either.
   */
  async createForKey(
    key: AuthenticatedApiKey,
    applicationId: string,
    dto: CreateConversationDto,
  ) {
    await this.access.requireApplicationInOrganization(key.organizationId, applicationId);
    return this.prisma.conversation.create({
      data: {
        applicationId,
        title: dto.title?.trim() || null,
      },
      select: {
        id: true,
        applicationId: true,
        title: true,
        archivedAt: true,
        createdAt: true,
      },
    });
  }

  /**
   * The one archive core shared by the JWT route and the genapi key
   * route: the archivedAt stamp is the honest signal that later
   * message writes on both surfaces refuse with the archived 409.
   * Archiving an already archived conversation stamps it again,
   * mirroring the idempotent GitHub conversation lock that succeeds
   * on every repeat.
   */
  private archiveForConversation(conversationId: string) {
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { archivedAt: new Date() },
      select: { id: true, title: true, archivedAt: true },
    });
  }

  async archive(userId: string, conversationId: string) {
    await this.access.requireConversationRole(
      userId,
      conversationId,
      this.access.writeRoles(),
    );
    return this.archiveForConversation(conversationId);
  }

  /**
   * Key-authenticated conversation archive. Grounded in the GitHub
   * conversation lock: write access is required to lock an issue, a
   * locked conversation blocks later comments, and repeat locks
   * succeed. WRITE_APPLICATIONS grants the archive; the writable
   * tenant bound refuses foreign, missing, and archived applications
   * with one uniform 404; the conversation must belong to the named
   * application so cross-application and unknown ids answer the same
   * uniform 404; and the response mirrors the JWT archive exactly,
   * with no audit row because the JWT archive writes none either.
   */
  async archiveForKey(
    key: AuthenticatedApiKey,
    applicationId: string,
    conversationId: string,
  ) {
    await this.access.requireApplicationInOrganization(key.organizationId, applicationId);
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, applicationId },
      select: { id: true },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }
    return this.archiveForConversation(conversationId);
  }

  /**
   * The one message-window law shared by the JWT route and the genapi
   * key route: take defaults to 100 and must be an integer between 1
   * and 100. The evaluation order is part of the contract - an invalid
   * take is a named 400 before any tenant lookups run, exactly like
   * the JWT route has always behaved.
   */
  static parseMessageTake(raw: string | undefined): number {
    const parsed = raw === undefined ? 100 : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new BadRequestException('take must be an integer between 1 and 100.');
    }
    return parsed;
  }

  /**
   * The optional before cursor must be a real date; anything else is a
   * named 400, never a silently ignored filter. Runs after the tenant
   * bound, matching the long-standing JWT evaluation order.
   */
  static parseMessageCursor(raw: string | undefined): Date | undefined {
    const cursorDate = raw ? new Date(raw) : undefined;
    if (cursorDate && Number.isNaN(cursorDate.getTime())) {
      throw new BadRequestException('Invalid message pagination cursor.');
    }
    return cursorDate;
  }

  /**
   * The one message-listing core shared by both surfaces: the newest
   * window is taken newest-first and then reversed so callers always
   * receive messages in ascending time order - the same oldest-first
   * order GitHub uses for issue comments.
   */
  private async listMessagesForConversation(
    conversationId: string,
    take: number,
    before?: Date,
  ) {
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...(before ? { createdAt: { lt: before } } : {}),
      },
      select: {
        id: true,
        conversationId: true,
        role: true,
        content: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(take, 1), 100),
    });
    return rows.reverse();
  }

  async listMessages(
    userId: string,
    conversationId: string,
    rawTake?: string,
    rawBefore?: string,
  ) {
    const take = ConversationService.parseMessageTake(rawTake);
    await this.access.requireConversationRole(
      userId,
      conversationId,
      this.access.allRoles(),
    );
    const before = ConversationService.parseMessageCursor(rawBefore);
    return this.listMessagesForConversation(conversationId, take, before);
  }

  /**
   * Key-authenticated message listing. The application must belong to the
   * key organization and the conversation must belong to that application;
   * foreign, cross-application, and missing conversations all answer the
   * same uniform 404 so a key can never probe another tenant.
   */
  async listMessagesForKey(
    key: AuthenticatedApiKey,
    applicationId: string,
    conversationId: string,
    rawTake?: string,
    rawBefore?: string,
  ) {
    const take = ConversationService.parseMessageTake(rawTake);
    await this.access.requireReadableApplicationInOrganization(key.organizationId, applicationId);
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, applicationId },
      select: { id: true },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }
    const before = ConversationService.parseMessageCursor(rawBefore);
    return this.listMessagesForConversation(conversationId, take, before);
  }

  async addUserMessage(userId: string, conversationId: string, dto: CreateMessageDto) {
    await this.access.requireConversationRole(
      userId,
      conversationId,
      this.access.writeRoles(),
    );
    this.secrets.assertNoSecrets(dto.content);
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { archivedAt: true },
    });
    if (!conversation || conversation.archivedAt) {
      throw new ConflictException('This conversation is archived or unavailable.');
    }

    return this.prisma.message.create({
      data: {
        conversationId,
        role: 'USER',
        content: dto.content.trim(),
      },
      select: {
        id: true,
        conversationId: true,
        role: true,
        content: true,
        createdAt: true,
      },
    });
  }

  /**
   * Key-authenticated user message. Grounded in the GitHub issue
   * comment write: a token with write permission may post comments and
   * the post is attributed to the token identity. The application must
   * belong to the key organization through the writable bound, so an
   * archived application refuses the write; the conversation must belong
   * to that application, so foreign, cross-application, and unknown
   * conversations all answer the same uniform 404 as the keyed read.
   * The secret scan runs before the archived check exactly like the
   * JWT route. Keyed messages carry their attribution metadata so
   * listings can show which key posted them; the response mirrors the
   * JWT response exactly, with no metadata field.
   */
  async addUserMessageForKey(
    key: AuthenticatedApiKey,
    applicationId: string,
    conversationId: string,
    dto: CreateMessageDto,
  ) {
    await this.access.requireApplicationInOrganization(key.organizationId, applicationId);
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, applicationId },
      select: { archivedAt: true },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }
    this.secrets.assertNoSecrets(dto.content);
    if (conversation.archivedAt) {
      throw new ConflictException('This conversation is archived or unavailable.');
    }
    return this.prisma.message.create({
      data: {
        conversationId,
        role: 'USER',
        content: dto.content.trim(),
        metadata: { via: 'genapi', apiKeyId: key.id, apiKeyName: key.name },
      },
      select: {
        id: true,
        conversationId: true,
        role: true,
        content: true,
        createdAt: true,
      },
    });
  }
}
