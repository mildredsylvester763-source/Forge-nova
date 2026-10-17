import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

export interface RecordResourceUsageInput {
  applicationId: string;
  jobId?: string;
  eventType: string;
  unit: string;
  quantity: number;
  provider?: string;
  model?: string;
  dimensions?: Record<string, unknown>;
  idempotencyKey?: string;
  occurredAt?: Date;
}

@Injectable()
export class ResourceMeterService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordResourceUsageInput) {
    if (!Number.isFinite(input.quantity) || input.quantity < 0 || input.quantity > 1e15) {
      throw new BadRequestException('Resource quantity must be a finite non-negative measurement.');
    }
    if (!/^[a-zA-Z0-9._:-]{2,100}$/.test(input.eventType)) {
      throw new BadRequestException('Resource event type is invalid.');
    }
    if (!/^[a-zA-Z0-9._/-]{1,40}$/.test(input.unit)) {
      throw new BadRequestException('Resource unit is invalid.');
    }
    if (input.idempotencyKey && !/^[a-zA-Z0-9._:-]{8,128}$/.test(input.idempotencyKey)) {
      throw new BadRequestException('Resource idempotency key is invalid.');
    }

    if (input.jobId) {
      const job = await this.prisma.workJob.findFirst({
        where: { id: input.jobId, applicationId: input.applicationId },
        select: { id: true },
      });
      if (!job) throw new NotFoundException('Job not found for this application.');
    }

    const dimensions = input.dimensions ?? {};
    if (Buffer.byteLength(JSON.stringify(dimensions), 'utf8') > 32768) {
      throw new BadRequestException('Resource event dimensions cannot exceed 32 KB.');
    }

    if (input.idempotencyKey) {
      const existing = await this.prisma.resourceUsageEvent.findFirst({
        where: { applicationId: input.applicationId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        const same =
          existing.eventType === input.eventType &&
          existing.unit === input.unit &&
          existing.quantity.equals(new Prisma.Decimal(input.quantity)) &&
          existing.jobId === (input.jobId ?? null);
        if (!same) throw new ConflictException('Resource idempotency key was reused for a different event.');
        return existing;
      }
    }

    try {
      return await this.prisma.resourceUsageEvent.create({
        data: {
          applicationId: input.applicationId,
          jobId: input.jobId ?? null,
          eventType: input.eventType,
          unit: input.unit,
          quantity: new Prisma.Decimal(input.quantity),
          provider: input.provider?.slice(0, 100),
          model: input.model?.slice(0, 160),
          dimensions: dimensions as Prisma.InputJsonValue,
          idempotencyKey: input.idempotencyKey ?? null,
          occurredAt: input.occurredAt ?? new Date(),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Resource event already exists for this idempotency key.');
      }
      throw error;
    }
  }
}
