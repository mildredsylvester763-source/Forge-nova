import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';

@Module({
  imports: [SecurityModule],
  controllers: [ConversationController],
  providers: [ConversationService],
})
export class ConversationModule {}
