import { AiCompletionInput, AiCompletionResult, AiProviderId } from '../ai.types';

export interface AiProvider {
  readonly id: AiProviderId;
  isConfigured(): boolean;
  defaultModel(): string | undefined;
  complete(input: AiCompletionInput): Promise<Omit<AiCompletionResult, 'meteringCallId'>>;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly provider: AiProviderId,
    readonly retryable: boolean,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
