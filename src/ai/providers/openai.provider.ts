import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiCompletionInput, AiCompletionResult } from '../ai.types';
import { AiProvider, AiProviderError } from './ai-provider.interface';
import { postProviderJson, requireText } from './provider-http';

@Injectable()
export class OpenAiProvider implements AiProvider {
  readonly id = 'openai' as const;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('OPENAI_API_KEY'));
  }

  defaultModel(): string | undefined {
    return this.config.get<string>('OPENAI_DEFAULT_MODEL');
  }

  async complete(input: AiCompletionInput): Promise<Omit<AiCompletionResult, 'meteringCallId'>> {
    const apiKey = this.config.getOrThrow<string>('OPENAI_API_KEY');
    const model = input.model ?? this.defaultModel();
    if (!model) throw new AiProviderError('No OpenAI model is configured for this request.', this.id, false);
    const timeoutMs = input.timeoutMs ?? this.config.get<number>('AI_PROVIDER_TIMEOUT_MS', 60_000);
    const { data, requestId } = await postProviderJson(
      this.id,
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${apiKey}` },
      {
        model,
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.userPrompt },
        ],
        max_completion_tokens: input.maxOutputTokens,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      },
      timeoutMs,
      input.signal,
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
