import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ResourceMeterService } from '../execution/resource-meter.service';
import { AiCompletionInput, AiCompletionResult, AiProviderId } from './ai.types';
import { AiProviderError } from './providers/ai-provider.interface';
import { AiProviderRegistry } from './ai-provider-registry.service';
import { SecretScannerService } from '../security/secret-scanner.service';

@Injectable()
export class AiRouterService {
  constructor(
    private readonly registry: AiProviderRegistry,
    private readonly meter: ResourceMeterService,
    private readonly config: ConfigService,
    private readonly secrets: SecretScannerService,
  ) {}

  availableProviders() {
    return this.registry.available();
  }

  async complete(input: AiCompletionInput): Promise<AiCompletionResult> {
    if (!input.applicationId || !input.operationId) {
      throw new BadRequestException('Application scope and operationId are required for auditable AI execution.');
    }
    if (!input.systemPrompt.trim() || !input.userPrompt.trim()) {
      throw new BadRequestException('System and user prompts must not be empty.');
    }
    this.secrets.assertNoSecrets(input.systemPrompt);
    this.secrets.assertNoSecrets(input.userPrompt);
    if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 32768) {
      throw new BadRequestException('maxOutputTokens must be an integer from 1 to 32768.');
    }
    if (input.model && !input.provider) {
      throw new BadRequestException('Specify a provider when selecting an exact model identifier.');
    }

    const ordered = input.provider
      ? this.preferredOrder(input.provider)
      : this.registry.ordered();
    const allowFallback = input.allowFallback !== false && !input.model;
    const candidates = ordered.filter((provider) => provider.isConfigured());
    if (input.provider && input.model) {
      const selected = this.registry.get(input.provider);
      if (!selected?.isConfigured()) {
        throw new ServiceUnavailableException('The requested AI provider is not configured.');
      }
    }

    if (candidates.length === 0) {
      throw new ServiceUnavailableException('No AI provider is configured. Configure a server-side provider key and default model.');
    }

    const attempts = allowFallback ? candidates : candidates.slice(0, 1);
    const failures: string[] = [];
    for (const provider of attempts) {
      const model = input.model ?? provider.defaultModel();
      if (!model) {
        failures.push(`${provider.id}: no default model configured`);
        continue;
      }

      const attemptId = randomUUID();
      const baseDimensions = {
        operationId: input.operationId,
        provider: provider.id,
        model,
      };

      // Record the provider attempt before making a billable external request.
      await this.meter.record({
        applicationId: input.applicationId,
        jobId: input.jobId,
        eventType: 'ai.provider_attempts',
        unit: 'calls',
        quantity: 1,
        provider: provider.id,
        model,
        dimensions: { ...baseDimensions, outcome: 'ATTEMPT' },
        idempotencyKey: `ai:${attemptId}:attempt`,
      });

      try {
        const result = await provider.complete({
          ...input,
          provider: provider.id,
          model,
          timeoutMs: input.timeoutMs ?? this.config.get<number>('AI_PROVIDER_TIMEOUT_MS', 60_000),
        });

        const dimensions = {
          ...baseDimensions,
          providerRequestId: result.providerRequestId ?? null,
        };
        await this.meter.record({
          applicationId: input.applicationId,
          jobId: input.jobId,
          eventType: 'ai.completion_successes',
          unit: 'calls',
          quantity: 1,
          provider: result.provider,
          model: result.model,
          dimensions,
          idempotencyKey: `ai:${attemptId}:success`,
        });
        if (result.usage.inputTokens !== undefined) {
          await this.meter.record({
            applicationId: input.applicationId,
            jobId: input.jobId,
            eventType: 'ai.input_tokens',
            unit: 'tokens',
            quantity: result.usage.inputTokens,
            provider: result.provider,
            model: result.model,
            dimensions,
            idempotencyKey: `ai:${attemptId}:input`,
          });
        }
        if (result.usage.outputTokens !== undefined) {
          await this.meter.record({
            applicationId: input.applicationId,
            jobId: input.jobId,
            eventType: 'ai.output_tokens',
            unit: 'tokens',
            quantity: result.usage.outputTokens,
            provider: result.provider,
            model: result.model,
            dimensions,
            idempotencyKey: `ai:${attemptId}:output`,
          });
        }

        return { ...result, meteringCallId: attemptId };
      } catch (error) {
        if (error instanceof AiProviderError) {
          await this.meter.record({
            applicationId: input.applicationId,
            jobId: input.jobId,
            eventType: 'ai.provider_failures',
            unit: 'calls',
            quantity: 1,
            provider: provider.id,
            model,
            dimensions: {
              ...baseDimensions,
              outcome: 'FAILURE',
              statusCode: error.statusCode ?? null,
              retryable: error.retryable,
            },
            idempotencyKey: `ai:${attemptId}:failure`,
          });
          failures.push(`${provider.id}: ${error.message}`);
          if (!allowFallback || !error.retryable) throw error;
          continue;
        }
        // Metering/database errors are not provider errors and must never trigger another paid model call.
        throw error;
      }
    }

    throw new ServiceUnavailableException(
      `No configured AI provider completed the request. Attempted providers: ${failures.join('; ')}`,
    );
  }

  private preferredOrder(preferred: AiProviderId) {
    const primary = this.registry.get(preferred);
    const remainder = this.registry.ordered().filter((provider) => provider.id !== preferred);
    return primary ? [primary, ...remainder] : remainder;
  }
}
