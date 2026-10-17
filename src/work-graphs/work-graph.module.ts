import { Module } from '@nestjs/common';
import { WorkGraphController } from './work-graph.controller';
import { WorkGraphService } from './work-graph.service';

@Module({
  controllers: [WorkGraphController],
  providers: [WorkGraphService],
})
export class WorkGraphModule {}
