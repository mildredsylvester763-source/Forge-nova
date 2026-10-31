import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { ApplicationModule } from '../applications/application.module';
import { CheckpointModule } from '../checkpoints/checkpoint.module';
import { FileModule } from '../files/file.module';
import { VerificationModule } from '../verification/verification.module';
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
  ],
  controllers: [ApiKeyAdminController, GenapiController],
  providers: [ApiKeyService, ApiKeyGuard],
  exports: [ApiKeyService, ApiKeyGuard],
})
export class ApiKeyModule {}
