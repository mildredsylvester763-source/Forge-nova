import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { SecurityModule } from '../security/security.module';
import { ReferencesController } from './references.controller';
import { ReferencesService } from './references.service';

@Module({
  imports: [AuthorizationModule, SecurityModule, AiModule],
  controllers: [ReferencesController],
  providers: [ReferencesService],
  exports: [ReferencesService],
})
export class ReferencesModule {}
