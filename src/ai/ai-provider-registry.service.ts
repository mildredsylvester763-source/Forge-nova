import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiProviderId } from './ai.types';
import { AiProvider } from './providers/ai-provider.interface';

export const AI_PROVIDER_ADAPTERS = Symbol('AI_PROVIDER_ADAPTERS');

@Injectable()
export class AiProviderRegistry {
  private readonly providersById: Map<AiProviderId, AiProvider>;
  private readonly priority: AiProviderId[];

  constructor(
    providers: AiProvider[],
    config: ConfigService,
  ) {
    this.providersById = new Map(providers.map((provider) => [provider.id, provider]));
    const allowed: AiProviderId[] = ['openai', 'anthropic', 'google', 'mistral'];
    const configured = (config.get<string>('AI_PROVIDER_PRIORITY') ?? 'openai,anthropic,google,mistral')
      .split(',')
      .map((item) => item.trim())
      .filter((item): item is AiProviderId => allowed.includes(item as AiProviderId));
    this.priority = [...new Set([...configured, ...allowed])];
  }

  get(id: AiProviderId): AiProvider | undefined {
    return this.providersById.get(id);
  }

  ordered(): AiProvider[] {
    return this.priority
      .map((id) => this.providersById.get(id))
      .filter((provider): provider is AiProvider => Boolean(provider));
  }

  available() {
    return this.ordered()
      .filter((provider) => provider.isConfigured() && Boolean(provider.defaultModel()))
      .map((provider) => ({ id: provider.id, defaultModel: provider.defaultModel() }));
  }
}
