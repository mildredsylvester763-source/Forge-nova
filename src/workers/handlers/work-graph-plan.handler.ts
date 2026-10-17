import { BadRequestException, Injectable } from '@nestjs/common';
import { JobType, Prisma, WorkJob } from '@prisma/client';
import { WorkGraphPlannerService } from '../../work-graphs/work-graph-planner.service';
import { ExecutionJobHandler } from '../execution-job-handler.interface';

@Injectable()
export class WorkGraphPlanJobHandler implements ExecutionJobHandler {
  readonly type = JobType.REQUIREMENTS_ANALYSIS;

  constructor(private readonly planner: WorkGraphPlannerService) {}

  async execute(job: WorkJob, signal: AbortSignal): Promise<Prisma.InputJsonValue> {
    const value = job.input;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Requirements-analysis job payload must be an object.');
    }
    const input = value as Record<string, unknown>;
    if (
      input.task !== 'PLAN_WORK_GRAPH' ||
      typeof input.graphId !== 'string' ||
      typeof input.requestedBy !== 'string'
    ) {
      throw new BadRequestException('Requirements-analysis job payload is invalid.');
    }

    const graph = await this.planner.plan(input.requestedBy, input.graphId, signal);
    return {
      graphId: graph.id,
      applicationId: graph.applicationId,
      title: graph.title,
      status: graph.status,
      version: graph.version,
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        key: node.key,
        type: node.type,
        title: node.title,
        status: node.status,
        riskLevel: node.riskLevel,
        requiresApproval: node.requiresApproval,
      })),
    } as Prisma.InputJsonValue;
  }
}
