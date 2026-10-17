import { ConflictException, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JobType } from '@prisma/client';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AccessControlService } from '../authorization/access-control.service';
import { JobQueueService } from '../execution/job-queue.service';
import { WorkGraphStatus } from '@prisma/client';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('work-graphs')
@UseGuards(JwtAuthGuard)
export class WorkGraphPlannerController {
  constructor(
    private readonly access: AccessControlService,
    private readonly jobs: JobQueueService,
  ) {}

  @Post(':graphId/plan')
  async plan(@Req() request: AuthenticatedRequest, @Param('graphId') graphId: string) {
    const graph = await this.access.requireWorkGraphRole(
      request.user.sub,
      graphId,
      this.access.writeRoles(),
    );
    const activeJob = await this.jobs.findActiveGraphPlanJob(graph.applicationId, graphId);
    if (activeJob) {
      return {
        jobId: activeJob.id,
        applicationId: activeJob.applicationId,
        status: activeJob.status,
        createdAt: activeJob.createdAt,
      };
    }

    if (graph.status !== WorkGraphStatus.DRAFT) {
      throw new ConflictException('Only draft work graphs can be queued for planning.');
    }

    const job = await this.jobs.enqueue(
      request.user.sub,
      graph.applicationId,
      JobType.REQUIREMENTS_ANALYSIS,
      {
        task: 'PLAN_WORK_GRAPH',
        graphId,
        requestedBy: request.user.sub,
      },
      `workgraph-plan:${graphId}:v${graph.version}`,
    );

    return {
      jobId: job.id,
      applicationId: graph.applicationId,
      status: job.status,
      createdAt: job.createdAt,
    };
  }
}
