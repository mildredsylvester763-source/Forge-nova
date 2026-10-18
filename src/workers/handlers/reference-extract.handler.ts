import { BadRequestException, Injectable } from '@nestjs/common';
import { JobType, Prisma, WorkJob } from '@prisma/client';
import { ReferencesService } from '../../references/references.service';
import { ExecutionJobHandler } from '../execution-job-handler.interface';

@Injectable()
export class ReferenceExtractJobHandler implements ExecutionJobHandler {
  readonly type = JobType.RESEARCH;

  constructor(private readonly references: ReferencesService) {}

  async execute(job: WorkJob, _signal: AbortSignal): Promise<Prisma.InputJsonValue> {
    const value = job.input;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Reference-extraction job payload must be an object.');
    }
    const input = value as Record<string, unknown>;
    if (
      input.task !== 'EXTRACT_REFERENCE_REQUIREMENTS' ||
      typeof input.referenceId !== 'string' ||
      typeof input.requestedBy !== 'string'
    ) {
      throw new BadRequestException('Reference-extraction job payload is invalid.');
    }

    const reference = await this.references.extract(
      input.requestedBy,
      job.applicationId,
      input.referenceId,
      job.id,
    );

    return {
      applicationId: job.applicationId,
      referenceId: input.referenceId,
      status: reference.status,
      extraction: reference.extraction ?? null,
    } as unknown as Prisma.InputJsonValue;
  }
}
