import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { IntegrationsController, WebhooksController } from './integrations.controller';
import { IntegrationService } from './integration.service';
import { WebhookService } from './webhook.service';

@Module({
  imports: [AuthorizationModule],
  controllers: [IntegrationsController, WebhooksController],
  providers: [IntegrationService, WebhookService],
  exports: [IntegrationService, WebhookService],
})
export class IntegrationsModule {}
