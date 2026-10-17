import { Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WorkGraphPlannerService } from './work-graph-planner.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('work-graphs')
@UseGuards(JwtAuthGuard)
export class WorkGraphPlannerController {
  constructor(private readonly planner: WorkGraphPlannerService) {}

  @Post(':graphId/plan')
  plan(@Req() request: AuthenticatedRequest, @Param('graphId') graphId: string) {
    return this.planner.plan(request.user.sub, graphId);
  }
}
