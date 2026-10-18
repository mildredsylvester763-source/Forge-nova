import { BadRequestException, Injectable } from '@nestjs/common';
import { JobType, Prisma, WorkJob } from '@prisma/client';
import { VERIFIABLE_KINDS, VerifiableKind } from '../../verification/dto/run-verification.dto';
import { VerificationService } from '../../verification/verification.service';
import { ExecutionJobHandler } from '../execution-job-handler.interface';

@Injectable()
export class VerificationScanJobHandler implements ExecutionJobHandler {
  readonly type = JobType.SECURITY_SCAN;

  constructor(private readonly verifications: VerificationService) {}

  async execute(job: WorkJob, _signal: AbortSignal): Promise<Prisma.InputJsonValue> {
    const value = job.input;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Security-scan job payload must be an object.');
    }
    const input = value as Record<string, unknown>;
    if (
      input.task !== 'RUN_VERIFICATION' ||
      typeof input.applicationId !== 'string' ||
      typeof input.requestedBy !== 'string'
    ) {
      throw new BadRequestException('Security-scan job payload is invalid.');
    }

    const requestedKinds = parseKinds(input.kinds);
    const runs = await this.verifications.runForApplication(
      input.requestedBy,
      input.applicationId,
      requestedKinds,
      job.id,
    );

    return {
      applicationId: input.applicationId,
      runs: runs.map((run) => ({
        id: run.id,
        kind: run.kind,
        status: run.status,
        summary: run.summary,
      })),
    } as unknown as Prisma.InputJsonValue;
  }
}

function parseKinds(value: unknown): VerifiableKind[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new BadRequestException('Security-scan job "kinds" must be an array of verification kinds.');
  }
  const kinds: VerifiableKind[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !(VERIFIABLE_KINDS as readonly string[]).includes(entry)) {
      throw new BadRequestException(`Security-scan job kind "${String(entry)}" is not a verifiable kind.`);
    }
    kinds.push(entry as VerifiableKind);
  }
  return kinds;
}
