import { ConfigService } from '@nestjs/config';
import { AiProviderRegistry } from './ai-provider-registry.service';
import { AiRouterService } from './ai-router.service';
import { AiProvider } from './providers/ai-provider.interface';
import { AiProviderError } from './providers/ai-provider.interface';
import { ResourceMeterService } from '../execution/resource-meter.service';
import { SecretScannerService } from '../security/secret-scanner.service';

describe('AiRouterService', () => {
  const meter = { record: jest.fn().mockResolvedValue({ id: 'usage-event' }) } as unknown as ResourceMeterService;
  const config = { get: jest.fn().mockReturnValue(60_000) } as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('falls back after a retryable provider failure and meters successful usage', async () => {
    const openai: AiProvider = {
      id: 'openai',
      isConfigured: () => true,
      defaultModel: () => 'openai-test-model',
      complete: jest.fn().mockRejectedValue(new AiProviderError('temporary outage', 'openai', true, 503)),
    };
    const anthropic: AiProvider = {
      id: 'anthropic',
      isConfigured: () => true,
      defaultModel: () => 'anthropic-test-model',
      complete: jest.fn().mockResolvedValue({
        provider: 'anthropic',
        model: 'anthropic-test-model',
        text: 'verified response',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      }),
    };
    const registry = {
      ordered: () => [openai, anthropic],
      get: (id: string) => id === 'openai' ? openai : id === 'anthropic' ? anthropic : undefined,
      available: () => [],
    } as unknown as AiProviderRegistry;
    const service = new AiRouterService(registry, meter, config, new SecretScannerService());

    const result = await service.complete({
      applicationId: 'app_1',
      operationId: 'op_1',
      systemPrompt: 'Follow the requirements.',
      userPrompt: 'Create a requirements summary.',
      maxOutputTokens: 500,
    });

    expect(result.provider).toBe('anthropic');
    expect(result.text).toBe('verified response');
    expect(result.meteringCallId).toBeTruthy();
    expect(meter.record).toHaveBeenCalledTimes(6);
  });

  it('requires application scope before making a provider call', async () => {
    const registry = { ordered: () => [], get: () => undefined, available: () => [] } as unknown as AiProviderRegistry;
    const service = new AiRouterService(registry, meter, config, new SecretScannerService());
    await expect(service.complete({
      applicationId: '',
      operationId: 'op_1',
      systemPrompt: 'System',
      userPrompt: 'User',
      maxOutputTokens: 100,
    })).rejects.toThrow(/Application scope/);
  });
});
