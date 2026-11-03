import { z } from 'zod';
import { systemRoleSchema } from './iam.js';

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((value) => value.toLowerCase());

/** NIST SP 800-63B: length matters, composition rules do not. */
export const passwordSchema = z.string().min(10).max(128);

export const registerRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    fullName: z.string().trim().min(1).max(120),
    /** Creates a new organization owned by the user. Required unless joining via invitation. */
    organizationName: z.string().trim().min(2).max(120).optional(),
    /** Joins an existing organization instead of creating one. */
    invitationToken: z.string().min(20).max(200).optional(),
  })
  .refine((value) => value.organizationName !== undefined || value.invitationToken !== undefined, {
    message: 'organizationName or invitationToken is required',
    path: ['organizationName'],
  });
export type RegisterRequest = z.input<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.input<typeof loginRequestSchema>;

export const userSummarySchema = z.object({
  id: z.uuid(),
  email: z.string(),
  fullName: z.string(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

export const authResponseSchema = z.object({
  accessToken: z.string(),
  /** Seconds until the access token expires. The refresh token travels in an httpOnly cookie. */
  expiresIn: z.number().int(),
  user: userSummarySchema,
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

export const membershipSummarySchema = z.object({
  organizationId: z.uuid(),
  organizationName: z.string(),
  organizationSlug: z.string(),
  organizationStatus: z.enum(['PROVISIONING', 'ACTIVE', 'SUSPENDED']),
  role: systemRoleSchema,
});
export type MembershipSummary = z.infer<typeof membershipSummarySchema>;

export const meResponseSchema = z.object({
  user: userSummarySchema,
  memberships: z.array(membershipSummarySchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Header carrying the active organization on tenant-scoped requests. */
export const ORGANIZATION_HEADER = 'x-organization-id';

/** Custom header required on cookie-authenticated endpoints (refresh/logout) as a CSRF guard. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'insightai';
