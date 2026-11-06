import type { DefaultJobOptions } from 'bullmq';

/** All BullMQ queues. */
export const QueueName = {
  SYSTEM: 'system',
  IMPORT: 'import',
  PROFILING: 'profiling',
  QUALITY: 'quality',
  CLEANING: 'cleaning',
  INVESTIGATION: 'investigation',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const SystemJob = {
  PING: 'ping',
} as const;

export const ImportJobName = {
  RUN: 'run',
} as const;

export const ProfilingJobName = {
  RUN: 'run',
} as const;

export interface ProfilingJobData {
  organizationId: string;
  versionId: string;
}

/** BullMQ job ids may not contain ":". */
export const profilingJobId = (versionId: string, suffix?: string) =>
  suffix ? `profile-${versionId}-${suffix}` : `profile-${versionId}`;

export const QualityJobName = {
  RUN: 'run',
} as const;

export interface QualityJobData {
  organizationId: string;
  checkId: string;
}

export const CleaningJobName = {
  RUN: 'run',
} as const;

export interface CleaningJobData {
  organizationId: string;
  cleaningJobId: string;
}

export const cleaningJobId = (id: string) => `cleaning-${id}`;

export const InvestigationJobName = {
  RUN: 'run',
} as const;

/** The worker runs every investigation as its author (RLS needs both ids to see the row). */
export interface InvestigationJobData {
  organizationId: string;
  userId: string;
  investigationId: string;
}

/** One job to plan, one more after an approval (completed job ids are kept for a day). */
export const investigationJobId = (id: string, phase: 'plan' | 'run') =>
  `investigation-${id}-${phase}`;

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
