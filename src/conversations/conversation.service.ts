import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { CreateMessageDto } from './dto/create-message.dto';

@Injectable()
export class ConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  async listForApplication(userId: string, applicationId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
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

  async archive(userId: string, conversationId: string) {
    await this.access.requireConversationRole(
      userId,
      conversationId,
      this.access.writeRoles(),
    );
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { archivedAt: new Date() },
      select: { id: true, title: true, archivedAt: true },
    });
  }

  async listMessages(userId: string, conversationId: string, take = 100, before?: string) {
    await this.access.requireConversationRole(
      userId,
      conversationId,
      this.access.allRoles(),
    );

    const cursorDate = before ? new Date(before) : undefined;
    if (cursorDate && Number.isNaN(cursorDate.getTime())) {
      throw new BadRequestException('Invalid message pagination cursor.');
    }

    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}),
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

  async addUserMessage(userId: string, conversationId: string, dto: CreateMessageDto) {
    await this.access.requireConversationRole(
      userId,
      conversationId,
      this.access.writeRoles(),
    );
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
}
