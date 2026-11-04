import { z } from 'zod';

/**
 * Stable machine-readable error codes. The frontend maps these to i18n messages,
 * so a code must never change meaning once released.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  QUERY_REJECTED: 'QUERY_REJECTED',
  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
  /** AI features are not configured (no LLM provider) on this server. */
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const fieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

/** RFC 7807 problem details, extended with `code` and `requestId`. */
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.enum(ErrorCode),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.array(fieldErrorSchema).optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
