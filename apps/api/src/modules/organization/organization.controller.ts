import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type CreateOrganizationRequest,
  createOrganizationRequestSchema,
  type CurrentOrganization,
  currentOrganizationSchema,
  type Organization,
  organizationSchema,
  Permission,
  type UpdateOrganizationRequest,
  updateOrganizationRequestSchema,
} from '@insightai/contracts';
import { RequirePermissions, TenantScoped } from '../../platform/http/decorators';
import {
  CurrentTenant,
  CurrentUser,
  type TenantContext,
  type UserContext,
} from '../../platform/http/request-context';
import { ApiZodBody, ApiZodResponse, zod } from '../../platform/http/zod';
import { OrganizationService } from './organization.service';

@ApiTags('organizations')
@Controller('organizations')
export class OrganizationController {
  constructor(private readonly organizations: OrganizationService) {}

  /** Creates an additional organization owned by the caller. (Listing lives in GET /auth/me.) */
  @Post()
  @ApiBearerAuth()
  @ApiZodBody(createOrganizationRequestSchema)
  @ApiZodResponse(201, organizationSchema)
  create(
    @CurrentUser() user: UserContext,
    @Body(zod(createOrganizationRequestSchema)) body: CreateOrganizationRequest,
  ): Promise<Organization> {
    return this.organizations.create(user, body.name);
  }

  @Get('current')
  @TenantScoped()
  @ApiZodResponse(200, currentOrganizationSchema)
  current(@CurrentTenant() ctx: TenantContext): Promise<CurrentOrganization> {
    return this.organizations.getCurrent(ctx);
  }

  @Patch('current')
  @RequirePermissions(Permission.ORG_UPDATE)
  @ApiZodBody(updateOrganizationRequestSchema)
  @ApiZodResponse(200, organizationSchema)
  update(
    @CurrentTenant() ctx: TenantContext,
    @Body(zod(updateOrganizationRequestSchema)) body: UpdateOrganizationRequest,
  ): Promise<Organization> {
    return this.organizations.update(ctx, body);
  }
}
