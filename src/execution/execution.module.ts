import { Module } from '@nestjs/common';
import { JobQueueService } from './job-queue.service';
import { ResourceMeterService } from './resource-meter.service';

@Module({
  providers: [JobQueueService, ResourceMeterService],
  exports: [JobQueueService, ResourceMeterService],
})
export class ExecutionModule {}
