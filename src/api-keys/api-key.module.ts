import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { ApplicationModule } from '../applications/application.module';
import { ExecutionModule } from '../execution/execution.module';
import { CheckpointModule } from '../checkpoints/checkpoint.module';
import { FileModule } from '../files/file.module';
import { VerificationModule } from '../verification/verification.module';
import { WorkGraphModule } from '../work-graphs/work-graph.module';
import { ConversationModule } from '../conversations/conversation.module';
import { ReferencesModule } from '../references/references.module';
import { ApiKeyAdminController, GenapiController } from './api-key.controller';
import { ApiKeyGuard } from './api-key.guard';
import { ApiKeyService } from './api-key.service';

@Module({
  imports: [
    AuthorizationModule,
    ApplicationModule,
    CheckpointModule,
    FileModule,
    VerificationModule,
    ExecutionModule,
    WorkGraphModule,
    ConversationModule,
    ReferencesModule,
  ],
  controllers: [ApiKeyAdminController, GenapiController],
  providers: [ApiKeyService, ApiKeyGuard],
  exports: [ApiKeyService, ApiKeyGuard],
})
export class ApiKeyModule {}
