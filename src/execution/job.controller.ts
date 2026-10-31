import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JobQueueService } from './job-queue.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('applications/:applicationId/jobs')
@UseGuards(JwtAuthGuard)
export class JobController {
  constructor(private readonly jobs: JobQueueService) {}

  /**
   * Lists the jobs of an application, newest first, optionally narrowed
   * by a validated status filter. Read access matches the inspect route:
   * every membership role may list. Mirrors the GitHub workflow-run
   * listing: read access is enough and unknown status filters are
   * refused by name instead of being silently ignored.
   */
  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Query('status') status?: string,
  ) {
    return this.jobs.listForUser(request.user.sub, applicationId, status);
  }

    @Get(':jobId')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.jobs.getForUser(request.user.sub, applicationId, jobId);
  }

  @Post(':jobId/cancel')
  cancel(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.jobs.requestCancellation(request.user.sub, applicationId, jobId);
  }
}
