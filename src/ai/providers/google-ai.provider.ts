import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiCompletionInput, AiCompletionResult } from '../ai.types';
import { AiProvider, AiProviderError } from './ai-provider.interface';
import { postProviderJson, requireText } from './provider-http';

@Injectable()
export class GoogleAiProvider implements AiProvider {
  readonly id = 'google' as const;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('GOOGLE_AI_API_KEY'));
  }

  defaultModel(): string | undefined {
    return this.config.get<string>('GOOGLE_AI_DEFAULT_MODEL');
  }

  async complete(input: AiCompletionInput): Promise<Omit<AiCompletionResult, 'meteringCallId'>> {
    const apiKey = this.config.getOrThrow<string>('GOOGLE_AI_API_KEY');
    const model = input.model ?? this.defaultModel();
    if (!model) throw new AiProviderError('No Google AI model is configured for this request.', this.id, false);
    const timeoutMs = input.timeoutMs ?? this.config.get<number>('AI_PROVIDER_TIMEOUT_MS', 60_000);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const { data, requestId } = await postProviderJson(
      this.id,
      url,
      {},
      {
        systemInstruction: { parts: [{ text: input.systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: input.userPrompt }] }],
        generationConfig: {
          maxOutputTokens: input.maxOutputTokens,
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        },
      },
      timeoutMs,
    );
    const text = requireText(
      data.candidates?.[0]?.content?.parts
        ?.map((part: any) => typeof part?.text === 'string' ? part.text : '')
        .join(''),
      this.id,
    );
    const usage = data.usageMetadata ?? {};
    return {
      provider: this.id,
      model,
      text,
      usage: {
        inputTokens: typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : undefined,
        outputTokens: typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : undefined,
        totalTokens: typeof usage.totalTokenCount === 'number' ? usage.totalTokenCount : undefined,
      },
      providerRequestId: requestId,
    };
  }
}
