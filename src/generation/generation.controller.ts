import { Controller, Post, Body, Param, Req, UseGuards } from '@nestjs/common';
import { JobType } from '@prisma/client';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JobQueueService } from '../execution/job-queue.service';
import { GenerateSourceDto } from './dto/generate-source.dto';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('applications/:applicationId/generate')
@UseGuards(JwtAuthGuard)
export class GenerationController {
  constructor(private readonly jobs: JobQueueService) {}

  @Post()
  async generate(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: GenerateSourceDto,
  ) {
    const job = await this.jobs.enqueue(
      request.user.sub,
      applicationId,
      JobType.CODE_GENERATION,
      {
        task: 'GENERATE_SOURCE_FILES',
        prompt: dto.prompt.trim(),
        requestedBy: request.user.sub,
      },
      dto.idempotencyKey,
    );

    return {
      jobId: job.id,
      applicationId,
      status: job.status,
      createdAt: job.createdAt,
    };
  }
}
