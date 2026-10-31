import { ConflictException, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JobType, WorkGraphStatus } from '@prisma/client';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AccessControlService } from '../authorization/access-control.service';
import { JobQueueService } from '../execution/job-queue.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

const RACE_RECHECK_ATTEMPTS = 10;
const RACE_RECHECK_DELAY_MS = 25;

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
      return this.toPlanView(activeJob);
    }

    if (graph.status !== WorkGraphStatus.DRAFT) {
      throw new ConflictException('Only draft work graphs can be queued for planning.');
    }

    const job = await this.enqueueOrConverge(request.user.sub, graph);
    return this.toPlanView(job);
  }

  // Two write members can press plan at the same moment: both miss the active
  // job lookup and both race the enqueue. The idempotency guard refuses the
  // loser because the requested-by metadata differs, even though the intent
  // is identical. The plan intent is the graph version, not the member who
  // pressed the button, so the loser converges on the winning job and both
  // callers receive the same clean answer.
  private async enqueueOrConverge(
    userId: string,
    graph: { id: string; applicationId: string; version: number },
  ) {
    try {
      return await this.jobs.enqueue(
        userId,
        graph.applicationId,
        JobType.REQUIREMENTS_ANALYSIS,
        {
          task: 'PLAN_WORK_GRAPH',
          graphId: graph.id,
          requestedBy: userId,
        },
        `workgraph-plan:${graph.id}:v${graph.version}`,
      );
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      for (let attempt = 0; attempt < RACE_RECHECK_ATTEMPTS; attempt += 1) {
        const raced = await this.jobs.findActiveGraphPlanJob(graph.applicationId, graph.id);
        if (raced) return raced;
        await new Promise((resolve) => setTimeout(resolve, RACE_RECHECK_DELAY_MS));
      }
      throw error;
    }
  }

  private toPlanView(job: { id: string; applicationId: string; status: string; createdAt: Date }) {
    return {
      jobId: job.id,
      applicationId: job.applicationId,
      status: job.status,
      createdAt: job.createdAt,
    };
  }
}