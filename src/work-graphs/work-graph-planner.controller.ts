import { Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AccessControlService } from '../authorization/access-control.service';
import { JobQueueService } from '../execution/job-queue.service';

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
    // The replay, draft gate, and race convergence laws live in the
    // one shared plan core, so the JWT and genapi key surfaces can
    // never drift apart.
    const job = await this.jobs.enqueueGraphPlan(request.user.sub, graph);
    return this.toPlanView(job);
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
