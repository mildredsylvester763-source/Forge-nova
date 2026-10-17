import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { CheckpointController } from './checkpoint.controller';
import { CheckpointService } from './checkpoint.service';

@Module({
  imports: [SecurityModule],
  controllers: [CheckpointController],
  providers: [CheckpointService],
  exports: [CheckpointService],
})
export class CheckpointModule {}
