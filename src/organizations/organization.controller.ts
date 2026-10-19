import {
  Body,
  Controller,
  Delete,
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
import { AddMemberDto } from './dto/add-member.dto';
import { ChangeMemberRoleDto } from './dto/change-member-role.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto';
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

  @Patch(':organizationId/members/:membershipId')
  changeMemberRole(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Param('membershipId') membershipId: string,
    @Body() dto: ChangeMemberRoleDto,
  ) {
    return this.organizations.changeMemberRole(request.user.sub, organizationId, membershipId, dto);
  }

  @Delete(':organizationId/members/:membershipId')
  removeMember(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Param('membershipId') membershipId: string,
  ) {
    return this.organizations.removeMember(request.user.sub, organizationId, membershipId);
  }

  @Post(':organizationId/ownership-transfer')
  transferOwnership(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
    @Body() dto: TransferOwnershipDto,
  ) {
    return this.organizations.transferOwnership(request.user.sub, organizationId, dto);
  }

  @Get(':organizationId/audit-events')
  listAuditEvents(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId') organizationId: string,
  ) {
    return this.organizations.listAuditEvents(request.user.sub, organizationId);
  }
}
