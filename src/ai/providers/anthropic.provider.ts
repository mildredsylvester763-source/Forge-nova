import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiCompletionInput, AiCompletionResult } from '../ai.types';
import { AiProvider, AiProviderError } from './ai-provider.interface';
import { postProviderJson, requireText } from './provider-http';

@Injectable()
export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic' as const;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('ANTHROPIC_API_KEY'));
  }

  defaultModel(): string | undefined {
    return this.config.get<string>('ANTHROPIC_DEFAULT_MODEL');
  }

  async complete(input: AiCompletionInput): Promise<Omit<AiCompletionResult, 'meteringCallId'>> {
    const apiKey = this.config.getOrThrow<string>('ANTHROPIC_API_KEY');
    const model = input.model ?? this.defaultModel();
    if (!model) throw new AiProviderError('No Anthropic model is configured for this request.', this.id, false);
    const timeoutMs = input.timeoutMs ?? this.config.get<number>('AI_PROVIDER_TIMEOUT_MS', 60_000);
    const { data, requestId } = await postProviderJson(
      this.id,
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      {
        model,
        system: input.systemPrompt,
        messages: [{ role: 'user', content: input.userPrompt }],
        max_tokens: input.maxOutputTokens,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      },
      timeoutMs,
    );
    const text = requireText(
      Array.isArray(data.content)
        ? data.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n')
        : undefined,
      this.id,
    );
    const usage = data.usage ?? {};
    return {
      provider: this.id,
      model,
      text,
      usage: {
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
        totalTokens:
          typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
            ? usage.input_tokens + usage.output_tokens
            : undefined,
      },
      providerRequestId: requestId ?? data.id,
    };
  }
}
