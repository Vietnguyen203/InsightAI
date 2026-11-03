import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission, SystemRole } from '@insightai/contracts';
import type { Request } from 'express';
import { UnauthenticatedError } from '../errors/app-error';

/** Identity established by the access token. */
export interface AuthenticatedUser {
  userId: string;
  sessionId: string;
}

/** Organization resolved and verified by TenantGuard for the current request. */
export interface TenantMembership {
  organizationId: string;
  dataSchema: string;
  membershipId: string;
  role: SystemRole;
  permissions: ReadonlySet<Permission>;
}

/** Request metadata recorded in audit logs. */
export interface RequestMeta {
  requestId: string | undefined;
  ip: string | undefined;
  userAgent: string | undefined;
}

export interface UserContext extends AuthenticatedUser, RequestMeta {}
export interface TenantContext extends UserContext, TenantMembership {}

export type AppRequest = Request & {
  id?: string | number;
  auth?: AuthenticatedUser;
  tenant?: TenantMembership;
};

export function requestMeta(req: AppRequest): RequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    requestId: req.id !== undefined ? String(req.id) : undefined,
    ip: req.ip,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : undefined,
  };
}

/** Authenticated user + request metadata. Use on non-tenant routes (e.g. /auth/me). */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): UserContext => {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.auth) throw new UnauthenticatedError('Authentication required');
    return { ...req.auth, ...requestMeta(req) };
  },
);

/** Authenticated user + verified organization membership. Use on tenant-scoped routes. */
export const CurrentTenant = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): TenantContext => {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.auth) throw new UnauthenticatedError('Authentication required');
    if (!req.tenant) {
      // Programming error: the route is missing @RequirePermissions/@TenantScoped.
      throw new Error('Tenant context requested on a route without tenant scope');
    }
    return { ...req.auth, ...req.tenant, ...requestMeta(req) };
  },
);
