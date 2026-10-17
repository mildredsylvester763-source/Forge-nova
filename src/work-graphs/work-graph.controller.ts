import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateWorkGraphDto } from './dto/create-work-graph.dto';
import { CreateWorkNodeDto } from './dto/create-work-node.dto';
import { WorkGraphService } from './work-graph.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller()
@UseGuards(JwtAuthGuard)
export class WorkGraphController {
  constructor(private readonly workGraphs: WorkGraphService) {}

  @Get('applications/:applicationId/work-graphs')
  listForApplication(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.workGraphs.listForApplication(request.user.sub, applicationId);
  }

  @Post('applications/:applicationId/work-graphs')
  create(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: CreateWorkGraphDto,
  ) {
    return this.workGraphs.create(request.user.sub, applicationId, dto);
  }

  @Get('work-graphs/:graphId')
  get(@Req() request: AuthenticatedRequest, @Param('graphId') graphId: string) {
    return this.workGraphs.get(request.user.sub, graphId);
  }

  @Post('work-graphs/:graphId/nodes')
  addNode(
    @Req() request: AuthenticatedRequest,
    @Param('graphId') graphId: string,
    @Body() dto: CreateWorkNodeDto,
  ) {
    return this.workGraphs.addNode(request.user.sub, graphId, dto);
  }

  @Get('work-graphs/:graphId/validate')
  validate(@Req() request: AuthenticatedRequest, @Param('graphId') graphId: string) {
    return this.workGraphs.validate(request.user.sub, graphId);
  }
}
