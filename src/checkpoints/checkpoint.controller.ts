import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateCheckpointDto } from './dto/create-checkpoint.dto';
import { CheckpointService } from './checkpoint.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('applications/:applicationId/checkpoints')
@UseGuards(JwtAuthGuard)
export class CheckpointController {
  constructor(private readonly checkpoints: CheckpointService) {}

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: CreateCheckpointDto,
  ) {
    return this.checkpoints.create(request.user.sub, applicationId, dto.label);
  }

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.checkpoints.list(request.user.sub, applicationId);
  }

  @Post(':checkpointId/restore')
  restore(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('checkpointId') checkpointId: string,
  ) {
    return this.checkpoints.restore(request.user.sub, applicationId, checkpointId);
  }
}
