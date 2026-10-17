import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ExecutionModule } from '../execution/execution.module';
import { SecurityModule } from '../security/security.module';
import { AI_PROVIDER_ADAPTERS, AiProviderRegistry } from './ai-provider-registry.service';
import { AiRouterService } from './ai-router.service';
import { AnthropicProvider } from './providers/anthropic.provider';
import { GoogleAiProvider } from './providers/google-ai.provider';
import { MistralProvider } from './providers/mistral.provider';
import { OpenAiProvider } from './providers/openai.provider';

@Module({
  imports: [ConfigModule, ExecutionModule, SecurityModule],
  providers: [
    OpenAiProvider,
    AnthropicProvider,
    GoogleAiProvider,
    MistralProvider,
    {
      provide: AI_PROVIDER_ADAPTERS,
      useFactory: (
        openai: OpenAiProvider,
        anthropic: AnthropicProvider,
        google: GoogleAiProvider,
        mistral: MistralProvider,
      ) => [openai, anthropic, google, mistral],
      inject: [OpenAiProvider, AnthropicProvider, GoogleAiProvider, MistralProvider],
    },
    {
      provide: AiProviderRegistry,
      useFactory: (providers: any[], config: ConfigService) => new AiProviderRegistry(providers, config),
      inject: [AI_PROVIDER_ADAPTERS, ConfigService],
    },
    AiRouterService,
  ],
  exports: [AiRouterService, AiProviderRegistry],
})
export class AiModule {}
