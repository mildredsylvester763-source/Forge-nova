import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ExecutionModule } from '../execution/execution.module';
import { WorkGraphModule } from '../work-graphs/work-graph.module';
import { AiModule } from '../ai/ai.module';
import { FileModule } from '../files/file.module';
import { SecurityModule } from '../security/security.module';
import { VerificationModule } from '../verification/verification.module';
import { CodeGenerationJobHandler } from '../generation/code-generation.handler';
import { SourceSyntaxValidatorService } from '../generation/source-syntax-validator.service';
import { ExecutionHandlerRegistry } from './execution-handler.registry';
import { WorkGraphPlanJobHandler } from './handlers/work-graph-plan.handler';
import { VerificationScanJobHandler } from './handlers/verification-scan.handler';
import { ExecutionWorker } from './execution-worker.service';

@Module({
  imports: [ConfigModule, ExecutionModule, WorkGraphModule, AiModule, FileModule, SecurityModule, VerificationModule],
  providers: [
    WorkGraphPlanJobHandler,
    CodeGenerationJobHandler,
    VerificationScanJobHandler,
    SourceSyntaxValidatorService,
    {
      provide: 'EXECUTION_JOB_HANDLERS',
      useFactory: (
        planner: WorkGraphPlanJobHandler,
        codeGeneration: CodeGenerationJobHandler,
        verificationScan: VerificationScanJobHandler,
      ) => [planner, codeGeneration, verificationScan],
      inject: [WorkGraphPlanJobHandler, CodeGenerationJobHandler, VerificationScanJobHandler],
    },
    {
      provide: ExecutionHandlerRegistry,
      useFactory: (
        handlers: Array<WorkGraphPlanJobHandler | CodeGenerationJobHandler | VerificationScanJobHandler>,
      ) => new ExecutionHandlerRegistry(handlers),
      inject: ['EXECUTION_JOB_HANDLERS'],
    },
    ExecutionWorker,
  ],
})
export class WorkerModule {}
