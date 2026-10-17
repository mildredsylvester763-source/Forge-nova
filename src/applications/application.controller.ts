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
import { CreateApplicationDto } from './dto/create-application.dto';
import { ApplicationService } from './application.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('projects/:projectId/applications')
@UseGuards(JwtAuthGuard)
export class ApplicationController {
  constructor(private readonly applications: ApplicationService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.applications.listForProject(request.user.sub, projectId);
  }

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: CreateApplicationDto,
  ) {
    return this.applications.create(request.user.sub, projectId, dto);
  }
}
