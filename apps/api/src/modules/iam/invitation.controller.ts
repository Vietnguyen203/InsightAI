import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  acceptInvitationRequestSchema,
  type CreatedInvitation,
  createdInvitationSchema,
  createInvitationRequestSchema,
  type Invitation,
  type InvitationPreview,
  invitationPreviewSchema,
  invitationSchema,
  type MembershipSummary,
  membershipSummarySchema,
  Permission,
} from '@insightai/contracts';
import { z } from 'zod';
import { Public, RequirePermissions } from '../../platform/http/decorators';
import {
  CurrentTenant,
  CurrentUser,
  type TenantContext,
  type UserContext,
} from '../../platform/http/request-context';
import { ApiZodBody, ApiZodResponse, zod } from '../../platform/http/zod';
import { InvitationService } from './invitation.service';

/** Tokens travel in request bodies, never in URLs, so they stay out of access logs. */
@ApiTags('invitations')
@Controller('invitations')
export class InvitationController {
  constructor(private readonly invitations: InvitationService) {}

  @Post()
  @RequirePermissions(Permission.INVITATION_MANAGE)
  @ApiZodBody(createInvitationRequestSchema)
  @ApiZodResponse(201, createdInvitationSchema)
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body(zod(createInvitationRequestSchema)) body: z.output<typeof createInvitationRequestSchema>,
  ): Promise<CreatedInvitation> {
    return this.invitations.create(ctx, body);
  }

  @Get()
  @RequirePermissions(Permission.INVITATION_MANAGE)
  @ApiZodResponse(200, z.array(invitationSchema))
  list(@CurrentTenant() ctx: TenantContext): Promise<Invitation[]> {
    return this.invitations.listActive(ctx);
  }

  @Delete(':invitationId')
  @HttpCode(204)
  @RequirePermissions(Permission.INVITATION_MANAGE)
  revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ): Promise<void> {
    return this.invitations.revoke(ctx, invitationId);
  }

  @Post('preview')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiZodBody(acceptInvitationRequestSchema)
  @ApiZodResponse(200, invitationPreviewSchema)
  preview(
    @Body(zod(acceptInvitationRequestSchema)) body: z.output<typeof acceptInvitationRequestSchema>,
  ): Promise<InvitationPreview> {
    return this.invitations.preview(body.token);
  }

  @Post('accept')
  @HttpCode(200)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiZodBody(acceptInvitationRequestSchema)
  @ApiZodResponse(200, membershipSummarySchema)
  accept(
    @CurrentUser() user: UserContext,
    @Body(zod(acceptInvitationRequestSchema)) body: z.output<typeof acceptInvitationRequestSchema>,
  ): Promise<MembershipSummary> {
    return this.invitations.accept(user, body.token);
  }
}
