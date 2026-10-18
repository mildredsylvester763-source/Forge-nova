import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateReferenceDto } from './dto/create-reference.dto';
import { ReferencesService } from './references.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('applications/:applicationId/references')
@UseGuards(JwtAuthGuard)
export class ReferencesController {
  constructor(private readonly references: ReferencesService) {}

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: CreateReferenceDto,
  ) {
    return this.references.create(request.user.sub, applicationId, dto);
  }

  @Get()
  list(@Req() request: AuthenticatedRequest, @Param('applicationId') applicationId: string) {
    return this.references.list(request.user.sub, applicationId);
  }

  @Get(':referenceId')
  findOne(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('referenceId') referenceId: string,
  ) {
    return this.references.findOne(request.user.sub, applicationId, referenceId);
  }

  @Post(':referenceId/extract')
  extract(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('referenceId') referenceId: string,
  ) {
    return this.references.extract(request.user.sub, applicationId, referenceId);
  }

  @Delete(':referenceId')
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('referenceId') referenceId: string,
  ) {
    return this.references.remove(request.user.sub, applicationId, referenceId);
  }
}
