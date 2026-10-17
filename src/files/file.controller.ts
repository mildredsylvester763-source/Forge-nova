import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WriteFileDto } from './dto/write-file.dto';
import { RestoreFileDto } from './dto/restore-file.dto';
import { FileService } from './file.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('applications/:applicationId/files')
@UseGuards(JwtAuthGuard)
export class FileController {
  constructor(private readonly files: FileService) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.files.list(request.user.sub, applicationId);
  }

  @Get(':fileId')
  read(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('fileId') fileId: string,
  ) {
    return this.files.read(request.user.sub, applicationId, fileId);
  }

  @Post()
  write(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: WriteFileDto,
  ) {
    return this.files.write(request.user.sub, applicationId, dto);
  }

  @Get(':fileId/revisions')
  revisions(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('fileId') fileId: string,
  ) {
    return this.files.revisions(request.user.sub, applicationId, fileId);
  }

  @Post(':fileId/restore/:revision')
  restore(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('fileId') fileId: string,
    @Param('revision', ParseIntPipe) revision: number,
    @Body() body: RestoreFileDto,
  ) {
    return this.files.restore(
      request.user.sub,
      applicationId,
      fileId,
      revision,
      body.expectedCurrentRevision,
    );
  }

  @Delete(':fileId/revision/:expectedRevision')
  delete(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('fileId') fileId: string,
    @Param('expectedRevision', ParseIntPipe) expectedRevision: number,
  ) {
    return this.files.delete(request.user.sub, applicationId, fileId, expectedRevision);
  }
}
