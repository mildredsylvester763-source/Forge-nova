import { Module } from '@nestjs/common';
import { ExecutionModule } from '../execution/execution.module';
import { GenerationController } from './generation.controller';

@Module({
  imports: [ExecutionModule],
  controllers: [GenerationController],
})
export class GenerationModule {}
