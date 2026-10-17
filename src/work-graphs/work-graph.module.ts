import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { WorkGraphController } from './work-graph.controller';
import { WorkGraphService } from './work-graph.service';
import { WorkGraphPlannerController } from './work-graph-planner.controller';
import { WorkGraphPlannerService } from './work-graph-planner.service';

@Module({
  imports: [SecurityModule],
  controllers: [WorkGraphController, WorkGraphPlannerController],
  providers: [WorkGraphService, WorkGraphPlannerService],
})
export class WorkGraphModule {}
