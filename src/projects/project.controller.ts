import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectService } from './project.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller()
@UseGuards(JwtAuthGuard)
export class ProjectController {
  constructor(private readonly projects: ProjectService) {}

  @Get('workspaces/:workspaceId/projects')
  listInWorkspace(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.projects.listInWorkspace(request.user.sub, workspaceId);
  }

  @Post('workspaces/:workspaceId/projects')
  create(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateProjectDto,
  ) {
    return this.projects.create(request.user.sub, workspaceId, dto);
  }

  @Get('projects/:projectId')
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.projects.get(request.user.sub, projectId);
  }

  @Patch('projects/:projectId')
  update(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projects.update(request.user.sub, projectId, dto);
  }

  @Post('projects/:projectId/archive')
  archive(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.projects.archive(request.user.sub, projectId);
  }

  @Post('projects/:projectId/restore')
  restore(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.projects.restore(request.user.sub, projectId);
  }
}
