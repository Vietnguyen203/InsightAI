import type { DefaultJobOptions } from 'bullmq';

/** All BullMQ queues. Later phases add profiling, quality and cleaning. */
export const QueueName = {
  SYSTEM: 'system',
  IMPORT: 'import',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const SystemJob = {
  PING: 'ping',
} as const;

export const ImportJobName = {
  RUN: 'run',
} as const;

export interface ImportJobData {
  organizationId: string;
  importJobId: string;
}

/**
 * Defaults for every job. Jobs must be idempotent: callers pass a deterministic `jobId`
 * (usually the id of the DB row tracking the job), and PostgreSQL – not Redis – is the
 * source of truth for job state.
 */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};
