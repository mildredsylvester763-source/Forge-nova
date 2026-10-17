import { JobType, Prisma, WorkJob } from '@prisma/client';

export interface ExecutionJobHandler {
  readonly type: JobType;
  execute(job: WorkJob, signal: AbortSignal): Promise<Prisma.InputJsonValue>;
}
