import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ConversationService } from './conversation.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { CreateMessageDto } from './dto/create-message.dto';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller()
@UseGuards(JwtAuthGuard)
export class ConversationController {
  constructor(private readonly conversations: ConversationService) {}

  @Get('applications/:applicationId/conversations')
  listForApplication(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.conversations.listForApplication(request.user.sub, applicationId);
  }

  @Post('applications/:applicationId/conversations')
  create(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversations.create(request.user.sub, applicationId, dto);
  }

  @Patch('conversations/:conversationId/archive')
  archive(
    @Req() request: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
  ) {
    return this.conversations.archive(request.user.sub, conversationId);
  }

  @Get('conversations/:conversationId/messages')
  listMessages(
    @Req() request: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Query('take') take?: string,
    @Query('before') before?: string,
  ) {
    const parsedTake = take === undefined ? 100 : Number(take);
    if (!Number.isInteger(parsedTake) || parsedTake < 1 || parsedTake > 100) {
      throw new BadRequestException('take must be an integer between 1 and 100.');
    }
    return this.conversations.listMessages(
      request.user.sub,
      conversationId,
      parsedTake,
      before,
    );
  }

  @Post('conversations/:conversationId/messages')
  addUserMessage(
    @Req() request: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Body() dto: CreateMessageDto,
  ) {
    return this.conversations.addUserMessage(request.user.sub, conversationId, dto);
  }
}
