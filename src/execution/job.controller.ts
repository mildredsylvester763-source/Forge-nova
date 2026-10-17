import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JobQueueService } from './job-queue.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('applications/:applicationId/jobs')
@UseGuards(JwtAuthGuard)
export class JobController {
  constructor(private readonly jobs: JobQueueService) {}

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
