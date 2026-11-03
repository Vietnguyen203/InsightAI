import { z } from 'zod';

export const healthComponentStatusSchema = z.enum(['up', 'down']);

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'error', 'shutting_down']),
  info: z.record(z.string(), z.object({ status: healthComponentStatusSchema }).loose()).optional(),
  error: z.record(z.string(), z.object({ status: healthComponentStatusSchema }).loose()).optional(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
