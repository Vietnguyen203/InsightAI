import { type CleaningJob as CleaningJobDto, cleaningOperationSchema } from '@insightai/contracts';
import type { CleaningJob, CleaningOperation } from '../../generated/prisma/client';

export function toCleaningJobDto(
  job: CleaningJob & {
    operations: CleaningOperation[];
    sourceVersion: { versionNo: number };
    targetVersion: { id: string } | null;
  },
): CleaningJobDto {
  return {
    id: job.id,
    datasetId: job.datasetId,
    sourceVersionId: job.sourceVersionId,
    sourceVersionNo: job.sourceVersion.versionNo,
    targetVersionId: job.targetVersion?.id ?? null,
    status: job.status,
    operations: job.operations.map((op) => ({
      seq: op.seq,
      operation: cleaningOperationSchema.parse(op.params),
      affectedRows: op.affectedRows === null ? null : Number(op.affectedRows),
      removedRows: op.removedRows === null ? null : Number(op.removedRows),
    })),
    error: (job.error as CleaningJobDto['error']) ?? null,
    requestedById: job.requestedById,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}
