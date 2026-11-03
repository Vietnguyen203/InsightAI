import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ORGANIZATION_HEADER, type Permission } from '@insightai/contracts';
import { UUID_PATTERN } from '../../platform/crypto/ids';
import {
  ForbiddenError,
  UnauthenticatedError,
  ValidationError,
} from '../../platform/errors/app-error';
import { REQUIRED_PERMISSIONS } from '../../platform/http/decorators';
import type { AppRequest } from '../../platform/http/request-context';
import { MembershipService } from './membership.service';

/**
 * For routes marked with @RequirePermissions/@TenantScoped: resolves the organization from
 * the X-Organization-Id header, verifies the caller is an active member, and checks every
 * required permission. Runs after AccessTokenGuard. The frontend is never trusted for this.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly memberships: MembershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined) return true; // not a tenant-scoped route

    const req = context.switchToHttp().getRequest<AppRequest>();
    if (!req.auth) throw new UnauthenticatedError('Authentication required');

    const organizationId = req.headers[ORGANIZATION_HEADER];
    if (typeof organizationId !== 'string' || !UUID_PATTERN.test(organizationId)) {
      throw new ValidationError(`Header ${ORGANIZATION_HEADER} must be an organization id`);
    }

    const tenant = await this.memberships.resolve(req.auth.userId, organizationId);
    const missing = required.filter((permission) => !tenant.permissions.has(permission));
    if (missing.length > 0) {
      throw new ForbiddenError(`Missing permission: ${missing.join(', ')}`);
    }

    req.tenant = tenant;
    return true;
  }
}
