export type AiProviderId = 'openai' | 'anthropic' | 'google' | 'mistral';

export interface AiCompletionInput {
  applicationId: string;
  jobId?: string;
  operationId: string;
  provider?: AiProviderId;
  model?: string;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  temperature?: number;
  timeoutMs?: number;
  allowFallback?: boolean;
}

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AiCompletionResult {
  provider: AiProviderId;
  model: string;
  text: string;
  usage: AiUsage;
  providerRequestId?: string;
  meteringCallId: string;
}
