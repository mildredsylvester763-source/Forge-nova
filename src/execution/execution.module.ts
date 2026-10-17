import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JobController } from './job.controller';
import { JobQueueService } from './job-queue.service';
import { ResourceMeterService } from './resource-meter.service';

@Module({
  imports: [AuthModule],
  controllers: [JobController],
  providers: [JobQueueService, ResourceMeterService],
  exports: [JobQueueService, ResourceMeterService],
})
export class ExecutionModule {}
