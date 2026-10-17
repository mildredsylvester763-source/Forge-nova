import { Injectable } from '@nestjs/common';
import { JobType } from '@prisma/client';
import { ExecutionJobHandler } from './execution-job-handler.interface';

@Injectable()
export class ExecutionHandlerRegistry {
  private readonly handlersByType: Map<JobType, ExecutionJobHandler>;

  constructor(handlers: ExecutionJobHandler[]) {
    this.handlersByType = new Map(handlers.map((handler) => [handler.type, handler]));
  }

  get(type: JobType): ExecutionJobHandler | undefined {
    return this.handlersByType.get(type);
  }

  registeredTypes(): JobType[] {
    return [...this.handlersByType.keys()];
  }
}
