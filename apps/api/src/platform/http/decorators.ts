import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { ORGANIZATION_HEADER, type Permission } from '@insightai/contracts';

export const IS_PUBLIC = 'insightai:isPublic';
export const REQUIRED_PERMISSIONS = 'insightai:requiredPermissions';

/** Opts a route out of the global access-token check. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Marks a route as tenant-scoped: the caller must send `X-Organization-Id`, be an active
 * member of that organization and hold every listed permission.
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  applyDecorators(
    SetMetadata(REQUIRED_PERMISSIONS, permissions),
    ApiBearerAuth(),
    ApiHeader({
      name: ORGANIZATION_HEADER,
      required: true,
      description: 'Active organization id',
    }),
  );

/** Tenant-scoped route that only needs membership (no specific permission). */
export const TenantScoped = () => RequirePermissions();
