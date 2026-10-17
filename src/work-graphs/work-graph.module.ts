import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ExecutionModule } from '../execution/execution.module';
import { SecurityModule } from '../security/security.module';
import { WorkGraphController } from './work-graph.controller';
import { WorkGraphService } from './work-graph.service';
import { WorkGraphPlannerController } from './work-graph-planner.controller';
import { WorkGraphPlannerService } from './work-graph-planner.service';

@Module({
  imports: [SecurityModule, AiModule, ExecutionModule],
  controllers: [WorkGraphController, WorkGraphPlannerController],
  providers: [WorkGraphService, WorkGraphPlannerService],
  exports: [WorkGraphPlannerService],
})
export class WorkGraphModule {}
