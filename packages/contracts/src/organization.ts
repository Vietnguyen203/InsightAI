import { z } from 'zod';
import { userSummarySchema } from './auth.js';
import { Permission, systemRoleSchema } from './iam.js';

/**
 * Accepts any IANA zone the runtime understands, including aliases. Do not validate against
 * `Intl.supportedValuesOf('timeZone')`: ICU lists legacy canonical ids there (e.g. `Asia/Saigon`)
 * and omits current names such as `Asia/Ho_Chi_Minh`, our default.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const organizationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(['PROVISIONING', 'ACTIVE', 'SUSPENDED']),
  timezone: z.string(),
  locale: z.string(),
  defaultCurrency: z.string(),
  createdAt: z.iso.datetime(),
});
export type Organization = z.infer<typeof organizationSchema>;

export const currentOrganizationSchema = organizationSchema.extend({
  role: systemRoleSchema,
  permissions: z.array(z.enum(Permission)),
});
export type CurrentOrganization = z.infer<typeof currentOrganizationSchema>;

export const createOrganizationRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
});
export type CreateOrganizationRequest = z.input<typeof createOrganizationRequestSchema>;

export const updateOrganizationRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    timezone: z.string().max(64).refine(isValidTimeZone, 'Unknown time zone'),
    locale: z.enum(['vi', 'en']),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export type UpdateOrganizationRequest = z.input<typeof updateOrganizationRequestSchema>;

export const memberSchema = z.object({
  id: z.uuid(),
  user: userSummarySchema,
  role: systemRoleSchema,
  status: z.enum(['ACTIVE', 'DISABLED']),
  joinedAt: z.iso.datetime(),
});
export type Member = z.infer<typeof memberSchema>;

export const updateMemberRequestSchema = z.object({ role: systemRoleSchema });
export type UpdateMemberRequest = z.input<typeof updateMemberRequestSchema>;

export const createInvitationRequestSchema = z.object({
  role: systemRoleSchema,
  expiresInHours: z.number().int().min(1).max(168).default(72),
});
export type CreateInvitationRequest = z.input<typeof createInvitationRequestSchema>;

export const invitationSchema = z.object({
  id: z.uuid(),
  role: systemRoleSchema,
  /** Null when the creator is no longer a member (not visible to the organization). */
  createdBy: userSummarySchema.nullable(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type Invitation = z.infer<typeof invitationSchema>;

/** Returned once, when the invitation is created: the token is never stored in clear text. */
export const createdInvitationSchema = invitationSchema.extend({ token: z.string() });
export type CreatedInvitation = z.infer<typeof createdInvitationSchema>;

export const invitationPreviewSchema = z.object({
  organizationName: z.string(),
  role: systemRoleSchema,
  expiresAt: z.iso.datetime(),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

export const acceptInvitationRequestSchema = z.object({ token: z.string().min(20).max(200) });
export type AcceptInvitationRequest = z.input<typeof acceptInvitationRequestSchema>;

export const auditLogEntrySchema = z.object({
  id: z.string(),
  actor: userSummarySchema.nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  changes: z.unknown().nullable(),
  ip: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(100).optional(),
});
export type PageQuery = z.input<typeof pageQuerySchema>;

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
