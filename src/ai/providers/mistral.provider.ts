import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiCompletionInput, AiCompletionResult } from '../ai.types';
import { AiProvider, AiProviderError } from './ai-provider.interface';
import { postProviderJson, requireText } from './provider-http';

@Injectable()
export class MistralProvider implements AiProvider {
  readonly id = 'mistral' as const;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('MISTRAL_API_KEY'));
  }

  defaultModel(): string | undefined {
    return this.config.get<string>('MISTRAL_DEFAULT_MODEL');
  }

  async complete(input: AiCompletionInput): Promise<Omit<AiCompletionResult, 'meteringCallId'>> {
    const apiKey = this.config.getOrThrow<string>('MISTRAL_API_KEY');
    const model = input.model ?? this.defaultModel();
    if (!model) throw new AiProviderError('No Mistral model is configured for this request.', this.id, false);
    const timeoutMs = input.timeoutMs ?? this.config.get<number>('AI_PROVIDER_TIMEOUT_MS', 60_000);
    const { data, requestId } = await postProviderJson(
      this.id,
      'https://api.mistral.ai/v1/chat/completions',
      { authorization: `Bearer ${apiKey}` },
      {
        model,
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.userPrompt },
        ],
        max_tokens: input.maxOutputTokens,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      },
      timeoutMs,
    );
    const text = requireText(data.choices?.[0]?.message?.content, this.id);
    const usage = data.usage ?? {};
    return {
      provider: this.id,
      model,
      text,
      usage: {
        inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
        outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
        totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
      },
      providerRequestId: requestId ?? data.id,
    };
  }
}
