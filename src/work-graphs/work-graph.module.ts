import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { WorkGraphController } from './work-graph.controller';
import { WorkGraphService } from './work-graph.service';

@Module({
  imports: [SecurityModule],
  controllers: [WorkGraphController],
  providers: [WorkGraphService],
})
export class WorkGraphModule {}
