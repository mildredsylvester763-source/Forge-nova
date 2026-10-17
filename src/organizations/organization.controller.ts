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
import { AddMemberDto } from './dto/add-member.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { OrganizationService } from './organization.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationController {
  constructor(private readonly organizations: OrganizationService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.organizations.listForUser(request.user.sub);
  }

  @Post()
  create(@Req() request: AuthenticatedRequest, @Body() dto: CreateOrganizationDto) {
    return this.organizations.create(request.user.sub, dto);
  }

  @Get(':organizationId/members')
  listMembers(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
  ) {
    return this.organizations.listMembers(request.user.sub, organizationId);
  }

  @Post(':organizationId/members')
  addMember(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Body() dto: AddMemberDto,
  ) {
    return this.organizations.addMember(request.user.sub, organizationId, dto);
  }
}
