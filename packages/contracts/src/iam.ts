import { z } from 'zod';

/**
 * Permission codes (`resource:action`). The database seeds the same codes and role matrix
 * (migration `*_iam_audit`); an integration test fails if the two drift apart.
 */
export const Permission = {
  ORG_READ: 'org:read',
  ORG_UPDATE: 'org:update',
  MEMBER_READ: 'member:read',
  MEMBER_MANAGE: 'member:manage',
  INVITATION_MANAGE: 'invitation:manage',
  AUDIT_READ: 'audit:read',
  DATASET_READ: 'dataset:read',
  DATASET_WRITE: 'dataset:write',
  QUALITY_READ: 'quality:read',
  QUALITY_WRITE: 'quality:write',
  QUALITY_APPLY_CLEANING: 'quality:apply_cleaning',
  SEMANTIC_READ: 'semantic:read',
  SEMANTIC_WRITE: 'semantic:write',
  SEMANTIC_PUBLISH: 'semantic:publish',
  SEMANTIC_QUERY: 'semantic:query',
  DASHBOARD_READ: 'dashboard:read',
  DASHBOARD_WRITE: 'dashboard:write',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS = Object.values(Permission);

export const SystemRole = {
  OWNER: 'owner',
  ADMIN: 'admin',
  ANALYST: 'analyst',
  VIEWER: 'viewer',
} as const;
export type SystemRole = (typeof SystemRole)[keyof typeof SystemRole];

const VIEWER_PERMISSIONS: Permission[] = [
  Permission.ORG_READ,
  Permission.MEMBER_READ,
  Permission.DATASET_READ,
  Permission.QUALITY_READ,
  Permission.SEMANTIC_READ,
  Permission.SEMANTIC_QUERY,
  Permission.DASHBOARD_READ,
];

const ANALYST_PERMISSIONS: Permission[] = [
  ...VIEWER_PERMISSIONS,
  Permission.DATASET_WRITE,
  Permission.QUALITY_WRITE,
  Permission.QUALITY_APPLY_CLEANING,
  Permission.SEMANTIC_WRITE,
  Permission.DASHBOARD_WRITE,
];

/**
 * Owner and admin hold the same permissions; what only an owner may do (grant or revoke the
 * owner role, remove an owner) is enforced as a business rule in the membership service.
 */
export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRole, readonly Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  analyst: ANALYST_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
};

export const systemRoleSchema = z.enum(SystemRole);
