import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  JobStatus,
  JobType,
  Prisma,
} from '@prisma/client';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';

const DEFAULT_LEASE_MS = 60_000;
const MIN_LEASE_MS = 10_000;
const MAX_LEASE_MS = 300_000;
const MAX_JOB_INPUT_BYTES = 262_144;
const MAX_JOB_RESULT_BYTES = 262_144;

@Injectable()
export class JobQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  async enqueue(
    userId: string,
    applicationId: string,
    type: JobType,
    input: Prisma.InputJsonValue,
    idempotencyKey?: string,
  ) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    const serialized = this.stableStringify(input);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JOB_INPUT_BYTES) {
      throw new BadRequestException('Job input cannot exceed 256 KB.');
    }
    if (idempotencyKey !== undefined && !/^[a-zA-Z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency key must contain 8–128 safe characters.');
    }

    if (idempotencyKey) {
      const existing = await this.prisma.workJob.findFirst({
        where: { applicationId, idempotencyKey },
      });
      if (existing) {
        if (this.stableStringify(existing.input as Prisma.InputJsonValue) !== serialized || existing.type !== type) {
          throw new ConflictException('This idempotency key was already used for a different job payload.');
        }
        if (existing.status === JobStatus.FAILED || existing.status === JobStatus.CANCELLED) {
          const reset = await this.prisma.workJob.updateMany({
            where: {
              id: existing.id,
              status: { in: [JobStatus.FAILED, JobStatus.CANCELLED] },
            },
            data: {
              status: JobStatus.QUEUED,
              result: Prisma.DbNull,
              errorCode: null,
              errorMessage: null,
              attemptCount: 0,
              reservedAt: null,
              startedAt: null,
              finishedAt: null,
              lockedBy: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              cancelRequestedAt: null,
            },
          });
          return this.prisma.workJob.findUniqueOrThrow({ where: { id: existing.id } });
        }
        return existing;
      }
    }

    try {
      return await this.prisma.workJob.create({
        data: {
          applicationId,
          type,
          input,
          idempotencyKey: idempotencyKey ?? null,
          status: JobStatus.QUEUED,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        if (idempotencyKey) {
          const raced = await this.prisma.workJob.findFirst({
            where: { applicationId, idempotencyKey },
          });
          if (
            raced &&
            raced.type === type &&
            this.stableStringify(raced.input as Prisma.InputJsonValue) === serialized
          ) {
            return raced;
          }
        }
        throw new ConflictException('A job with this idempotency key already exists.');
      }
      throw error;
    }
  }

  async claimNext(workerId: string, requestedLeaseMs = DEFAULT_LEASE_MS) {
    if (!/^[a-zA-Z0-9._:-]{3,120}$/.test(workerId)) {
      throw new BadRequestException('Worker identity is invalid.');
    }
    const leaseMs = Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, requestedLeaseMs));

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const exhausted = await tx.workJob.findMany({
        where: {
          status: JobStatus.RUNNING,
          leaseExpiresAt: { lte: now },
        },
        select: { id: true, attemptCount: true, maxAttempts: true, cancelRequestedAt: true },
      });
      for (const job of exhausted) {
        if (job.cancelRequestedAt || job.attemptCount >= job.maxAttempts) {
          await tx.workJob.updateMany({
            where: {
              id: job.id,
              status: JobStatus.RUNNING,
              leaseExpiresAt: { lte: now },
            },
            data: {
              status: job.cancelRequestedAt ? JobStatus.CANCELLED : JobStatus.FAILED,
              errorCode: job.cancelRequestedAt ? 'CANCELLED_AFTER_LEASE_EXPIRY' : 'WORKER_LEASE_EXHAUSTED',
              errorMessage: job.cancelRequestedAt ? 'The cancellation request was acknowledged after the worker lease expired.' : 'The job exhausted its allowed attempts without a valid worker lease.',
              finishedAt: now,
              lockedBy: null,
              leaseExpiresAt: null,
            },
          });
        }
      }

      const candidates = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "WorkJob"
         WHERE ("status" = 'QUEUED'
           OR ("status" = 'RUNNING' AND "leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" <= NOW() AND "cancelRequestedAt" IS NULL))
           AND "attemptCount" < "maxAttempts"
         ORDER BY "createdAt" ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      const candidate = candidates[0];
      if (!candidate) return null;

      return tx.workJob.update({
        where: { id: candidate.id },
        data: {
          status: JobStatus.RUNNING,
          attemptCount: { increment: 1 },
          lockedBy: workerId,
          leaseExpiresAt: new Date(Date.now() + leaseMs),
          heartbeatAt: now,
          startedAt: now,
          errorCode: null,
          errorMessage: null,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  async heartbeat(jobId: string, workerId: string, requestedLeaseMs = DEFAULT_LEASE_MS) {
    const leaseMs = Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, requestedLeaseMs));
    const now = new Date();
    const updated = await this.prisma.workJob.updateMany({
      where: {
        id: jobId,
        status: JobStatus.RUNNING,
        lockedBy: workerId,
        leaseExpiresAt: { gt: now },
      },
      data: {
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Worker lease is missing, expired, or owned by another worker.');
    }

    const job = await this.prisma.workJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { id: true, status: true, cancelRequestedAt: true, leaseExpiresAt: true },
    });
    return {
      jobId: job.id,
      leaseExpiresAt: job.leaseExpiresAt,
      cancellationRequested: job.cancelRequestedAt !== null,
    };
  }

  async complete(jobId: string, workerId: string, result: Prisma.InputJsonValue) {
    const serialized = this.stableStringify(result);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JOB_RESULT_BYTES) {
      throw new BadRequestException('Job result cannot exceed 256 KB.');
    }
    const now = new Date();
    const updated = await this.prisma.workJob.updateMany({
      where: {
        id: jobId,
        status: JobStatus.RUNNING,
        lockedBy: workerId,
        leaseExpiresAt: { gt: now },
        cancelRequestedAt: null,
      },
      data: {
        status: JobStatus.SUCCEEDED,
        result,
        finishedAt: now,
        lockedBy: null,
        leaseExpiresAt: null,
        heartbeatAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Job completion rejected because the worker lease or cancellation state changed.');
    }
    return this.prisma.workJob.findUniqueOrThrow({ where: { id: jobId } });
  }

  async fail(
    jobId: string,
    workerId: string,
    errorCode: string,
    safeErrorMessage: string,
    retryable: boolean,
  ) {
    const job = await this.prisma.workJob.findFirst({
      where: { id: jobId, status: JobStatus.RUNNING, lockedBy: workerId },
      select: { id: true, attemptCount: true, maxAttempts: true, cancelRequestedAt: true },
    });
    if (!job) throw new ConflictException('Job is no longer leased by this worker.');

    const cancellationRequested = job.cancelRequestedAt !== null;
    const shouldRetry = !cancellationRequested && retryable && job.attemptCount < job.maxAttempts;
    const finalStatus = cancellationRequested
      ? JobStatus.CANCELLED
      : shouldRetry
        ? JobStatus.QUEUED
        : JobStatus.FAILED;
    const now = new Date();
    const updated = await this.prisma.workJob.updateMany({
      where: { id: jobId, status: JobStatus.RUNNING, lockedBy: workerId, leaseExpiresAt: { gt: now } },
      data: {
        status: finalStatus,
        errorCode: cancellationRequested ? 'CANCELLED' : errorCode.slice(0, 100),
        errorMessage: cancellationRequested ? 'Cancellation was requested while the job was running.' : safeErrorMessage.slice(0, 2000),
        finishedAt: shouldRetry ? null : now,
        lockedBy: null,
        leaseExpiresAt: null,
        heartbeatAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Job state changed while recording the failure.');
    }
    return { id: jobId, status: finalStatus };
  }

  async acknowledgeCancellation(jobId: string, workerId: string) {
    const now = new Date();
    const updated = await this.prisma.workJob.updateMany({
      where: {
        id: jobId,
        status: JobStatus.RUNNING,
        lockedBy: workerId,
        cancelRequestedAt: { not: null },
      },
      data: {
        status: JobStatus.CANCELLED,
        finishedAt: now,
        lockedBy: null,
        leaseExpiresAt: null,
        heartbeatAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('No active cancellation request exists for this worker lease.');
    }
    return { id: jobId, status: JobStatus.CANCELLED };
  }

  async requestCancellation(userId: string, applicationId: string, jobId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    const job = await this.prisma.workJob.findFirst({
      where: { id: jobId, applicationId },
      select: { id: true, status: true, cancelRequestedAt: true },
    });
    if (!job) throw new NotFoundException('Job not found.');

    const now = new Date();
    if (job.status === JobStatus.QUEUED) {
      const cancelled = await this.prisma.workJob.updateMany({
        where: { id: jobId, status: JobStatus.QUEUED },
        data: {
          status: JobStatus.CANCELLED,
          finishedAt: now,
          cancelRequestedAt: now,
        },
      });
      if (cancelled.count === 1) {
        return { id: jobId, status: JobStatus.CANCELLED };
      }
      const latest = await this.prisma.workJob.findUnique({
        where: { id: jobId },
        select: { status: true, cancelRequestedAt: true },
      });
      if (!latest) throw new NotFoundException('Job not found.');
      if (latest.status === JobStatus.RUNNING) {
        const requested = await this.prisma.workJob.updateMany({
          where: { id: jobId, status: JobStatus.RUNNING, cancelRequestedAt: null },
          data: { cancelRequestedAt: now },
        });
        return {
          id: jobId,
          status: JobStatus.RUNNING,
          cancellationRequested: requested.count === 1 || latest.cancelRequestedAt !== null,
        };
      }
      return { id: jobId, status: latest.status, cancellationRequested: latest.cancelRequestedAt !== null };
    }

    if (job.status === JobStatus.RUNNING) {
      const requested = await this.prisma.workJob.updateMany({
        where: { id: jobId, status: JobStatus.RUNNING, cancelRequestedAt: null },
        data: { cancelRequestedAt: now },
      });
      const latest = await this.prisma.workJob.findUnique({
        where: { id: jobId },
        select: { status: true, cancelRequestedAt: true },
      });
      if (!latest) throw new NotFoundException('Job not found.');
      return {
        id: jobId,
        status: latest.status,
        cancellationRequested: requested.count === 1 || Boolean(latest.cancelRequestedAt),
      };
    }

    return { id: jobId, status: job.status, cancellationRequested: false };
  }

  async findActiveGraphPlanJob(applicationId: string, graphId: string) {
    return this.prisma.workJob.findFirst({
      where: {
        applicationId,
        type: JobType.REQUIREMENTS_ANALYSIS,
        status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
        AND: [
          { input: { path: ['graphId'], equals: graphId } },
          { input: { path: ['task'], equals: 'PLAN_WORK_GRAPH' } },
        ],
      },
      select: { id: true, applicationId: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getForUser(userId: string, applicationId: string, jobId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    const job = await this.prisma.workJob.findFirst({
      where: { id: jobId, applicationId },
      select: {
        id: true,
        applicationId: true,
        type: true,
        status: true,
        result: true,
        errorCode: true,
        attemptCount: true,
        maxAttempts: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
      },
    });
    if (!job) throw new NotFoundException('Job not found.');
    return job;
  }

  private stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${this.stableStringify(record[key])}`).join(',')}}`;
  }
}
