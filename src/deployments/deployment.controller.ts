import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateDeploymentDto } from './dto/create-deployment.dto';
import { DeploymentService } from './deployment.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('applications/:applicationId/deployments')
@UseGuards(JwtAuthGuard)
export class DeploymentController {
  constructor(private readonly deployments: DeploymentService) {}

  @Get('readiness')
  readiness(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.deployments.getReadiness(request.user.sub, applicationId);
  }

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: CreateDeploymentDto,
  ) {
    return this.deployments.createDeployment(request.user.sub, applicationId, dto);
  }

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.deployments.listForApplication(request.user.sub, applicationId);
  }

  @Get(':deploymentId')
  findOne(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('deploymentId') deploymentId: string,
  ) {
    return this.deployments.findOne(request.user.sub, applicationId, deploymentId);
  }
}
