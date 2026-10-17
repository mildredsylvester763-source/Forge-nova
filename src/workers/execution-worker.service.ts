import {
  HttpException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WorkJob } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AiProviderError } from '../ai/providers/ai-provider.interface';
import { JobQueueService } from '../execution/job-queue.service';
import { ExecutionHandlerRegistry } from './execution-handler.registry';

@Injectable()
export class ExecutionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionWorker.name);
  private readonly workerId = `worker-${randomUUID()}`;
  private readonly enabled: boolean;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private stopped = false;
  private currentController?: AbortController;

  constructor(
    private readonly jobs: JobQueueService,
    private readonly handlers: ExecutionHandlerRegistry,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('EXECUTION_WORKER_ENABLED', true);
    this.pollMs = config.get<number>('EXECUTION_WORKER_POLL_MS', 1000);
    this.leaseMs = config.get<number>('EXECUTION_WORKER_LEASE_MS', 60_000);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Execution worker is disabled by configuration.');
      return;
    }
    this.logger.log('Execution worker started.');
    void this.runLoop();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.currentController?.abort();
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const job = await this.jobs.claimNext(this.workerId, this.leaseMs);
        if (!job) {
          await this.sleep(this.pollMs);
          continue;
        }
        await this.process(job);
      } catch (error) {
        this.logger.error(
          'Execution worker loop encountered an error.',
          error instanceof Error ? error.name : 'UnknownError',
        );
        await this.sleep(this.pollMs);
      }
    }
  }

  private async process(job: WorkJob): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      try {
        await this.jobs.fail(
          job.id,
          this.workerId,
          'HANDLER_NOT_REGISTERED',
          'No execution handler is registered for this job type.',
          false,
        );
      } catch {
        // The lease may have expired or been recovered by another worker.
      }
      return;
    }

    const controller = new AbortController();
    this.currentController = controller;
    let leaseLost = false;
    let cancellationRequested = false;
    let heartbeatInFlight = false;

    const heartbeatInterval = setInterval(async () => {
      if (heartbeatInFlight || leaseLost || cancellationRequested) return;
      heartbeatInFlight = true;
      try {
        const heartbeat = await this.jobs.heartbeat(job.id, this.workerId, this.leaseMs);
        if (heartbeat.cancellationRequested) {
          cancellationRequested = true;
          controller.abort();
        }
      } catch {
        leaseLost = true;
        controller.abort();
      } finally {
        heartbeatInFlight = false;
      }
    }, Math.max(5_000, Math.floor(this.leaseMs / 3)));

    try {
      const result = await handler.execute(job, controller.signal);
      if (leaseLost) return;
      if (cancellationRequested) {
        await this.jobs.acknowledgeCancellation(job.id, this.workerId);
        return;
      }
      await this.jobs.complete(job.id, this.workerId, result);
    } catch (error) {
      if (leaseLost) return;
      if (cancellationRequested) {
        try {
          await this.jobs.acknowledgeCancellation(job.id, this.workerId);
        } catch {
          // A replacement worker may already have recovered the lease.
        }
        return;
      }

      const retryable = this.isRetryable(error);
      const errorCode =
        error instanceof AiProviderError
          ? `AI_PROVIDER_${error.retryable ? 'RETRYABLE' : 'FAILED'}`
          : error instanceof HttpException
            ? `HTTP_${error.getStatus()}`
            : 'EXECUTION_FAILED';
      const safeMessage =
        error instanceof AiProviderError
          ? `${error.provider} provider failed${error.statusCode ? ` with HTTP ${error.statusCode}` : ''}.`
          : error instanceof HttpException
            ? error.message.slice(0, 1000)
            : 'Execution failed. Inspect server-side diagnostics using the request/job identifier.';

      try {
        await this.jobs.fail(job.id, this.workerId, errorCode, safeMessage, retryable);
      } catch {
        // The lease may have expired or been recovered by another worker.
      }
    } finally {
      clearInterval(heartbeatInterval);
      if (this.currentController === controller) this.currentController = undefined;
    }
  }

  private isRetryable(error: unknown): boolean {
    if (this.stopped) return true;
    if (error instanceof AiProviderError) return error.retryable;
    if (error instanceof HttpException) {
      const message = error.message;
      return (
        error.getStatus() >= 500 &&
        /Attempted providers:.*(?:HTTP (?:408|429|5\d\d)|failed before a response)/i.test(message)
      );
    }
    return false;
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
