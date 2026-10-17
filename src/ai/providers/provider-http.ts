import { AiProviderId } from '../ai.types';
import { AiProviderError } from './ai-provider.interface';

export async function postProviderJson(
  provider: AiProviderId,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<{ data: Record<string, any>; requestId?: string }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new AiProviderError('AI provider request failed before a response was received.', provider, true);
  }

  let data: Record<string, any> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, any>;
    }
  } catch {
    // Provider error bodies are deliberately not surfaced because they can contain sensitive details.
  }

  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new AiProviderError(
      `AI provider returned HTTP ${response.status}.`,
      provider,
      retryable,
      response.status,
    );
  }

  return {
    data,
    requestId:
      response.headers.get('x-request-id') ??
      response.headers.get('request-id') ??
      undefined,
  };
}

export function requireText(value: unknown, provider: AiProviderId): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AiProviderError('AI provider returned no usable text content.', provider, false);
  }
  return value;
}
