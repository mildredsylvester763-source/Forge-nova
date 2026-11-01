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
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { WorkspaceService } from './workspace.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspaceController {
  constructor(private readonly workspaces: WorkspaceService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.workspaces.listForUser(request.user.sub);
  }

  @Post()
  create(@Req() request: AuthenticatedRequest, @Body() dto: CreateWorkspaceDto) {
    return this.workspaces.create(request.user.sub, dto);
  }

  /**
   * Workspace rename. Grounded in the GitHub team update, where
   * editing a grouping structure is an admin write and the name
   * changes while the slug stays stable: the slug is the immutable
   * server-derived identifier, so a rename never regenerates it.
   */
  @Patch(':workspaceId')
  update(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdateWorkspaceDto,
  ) {
    return this.workspaces.update(request.user.sub, workspaceId, dto);
  }
}

