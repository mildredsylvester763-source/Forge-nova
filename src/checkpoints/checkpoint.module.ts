import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { SecurityModule } from '../security/security.module';
import { CheckpointController } from './checkpoint.controller';
import { CheckpointService } from './checkpoint.service';

@Module({
  imports: [SecurityModule, IntegrationsModule],
  controllers: [CheckpointController],
  providers: [CheckpointService],
  exports: [CheckpointService],
})
export class CheckpointModule {}
