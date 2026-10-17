import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ExecutionModule } from '../execution/execution.module';
import { WorkGraphModule } from '../work-graphs/work-graph.module';
import { ExecutionHandlerRegistry } from './execution-handler.registry';
import { WorkGraphPlanJobHandler } from './handlers/work-graph-plan.handler';
import { ExecutionWorker } from './execution-worker.service';

@Module({
  imports: [ConfigModule, ExecutionModule, WorkGraphModule],
  providers: [
    WorkGraphPlanJobHandler,
    {
      provide: 'EXECUTION_JOB_HANDLERS',
      useFactory: (planner: WorkGraphPlanJobHandler) => [planner],
      inject: [WorkGraphPlanJobHandler],
    },
    {
      provide: ExecutionHandlerRegistry,
      useFactory: (handlers: WorkGraphPlanJobHandler[]) => new ExecutionHandlerRegistry(handlers),
      inject: ['EXECUTION_JOB_HANDLERS'],
    },
    ExecutionWorker,
  ],
})
export class WorkerModule {}
