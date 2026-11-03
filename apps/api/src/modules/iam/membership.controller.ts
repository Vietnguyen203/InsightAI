import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type Member,
  memberSchema,
  Permission,
  updateMemberRequestSchema,
} from '@insightai/contracts';
import { z } from 'zod';
import { RequirePermissions } from '../../platform/http/decorators';
import { CurrentTenant, type TenantContext } from '../../platform/http/request-context';
import { ApiZodBody, ApiZodResponse, zod } from '../../platform/http/zod';
import { MembershipService } from './membership.service';

@ApiTags('members')
@Controller('members')
export class MembershipController {
  constructor(private readonly memberships: MembershipService) {}

  @Get()
  @RequirePermissions(Permission.MEMBER_READ)
  @ApiZodResponse(200, z.array(memberSchema))
  list(@CurrentTenant() ctx: TenantContext): Promise<Member[]> {
    return this.memberships.list(ctx);
  }

  @Patch(':membershipId')
  @RequirePermissions(Permission.MEMBER_MANAGE)
  @ApiZodBody(updateMemberRequestSchema)
  @ApiZodResponse(200, memberSchema)
  changeRole(
    @CurrentTenant() ctx: TenantContext,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body(zod(updateMemberRequestSchema)) body: z.output<typeof updateMemberRequestSchema>,
  ): Promise<Member> {
    return this.memberships.changeRole(ctx, membershipId, body.role);
  }

  @Delete(':membershipId')
  @HttpCode(204)
  @RequirePermissions(Permission.MEMBER_MANAGE)
  remove(
    @CurrentTenant() ctx: TenantContext,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
  ): Promise<void> {
    return this.memberships.remove(ctx, membershipId);
  }
}
