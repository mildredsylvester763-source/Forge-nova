import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RunVerificationDto } from './dto/run-verification.dto';
import { VerificationService } from './verification.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('applications/:applicationId/verifications')
@UseGuards(JwtAuthGuard)
export class VerificationController {
  constructor(private readonly verifications: VerificationService) {}

  @Post()
  run(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto?: RunVerificationDto,
  ) {
    return this.verifications.runForApplication(request.user.sub, applicationId, dto?.kinds);
  }

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
  ) {
    return this.verifications.listForApplication(request.user.sub, applicationId);
  }

  @Get(':verificationId')
  findOne(
    @Req() request: AuthenticatedRequest,
    @Param('applicationId') applicationId: string,
    @Param('verificationId') verificationId: string,
  ) {
    return this.verifications.findOne(request.user.sub, applicationId, verificationId);
  }
}
