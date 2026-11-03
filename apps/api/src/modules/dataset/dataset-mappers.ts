import type {
  DatasetColumn as DatasetColumnDto,
  DatasetSummary,
  DatasetVersion as DatasetVersionDto,
  ImportJob as ImportJobDto,
} from '@insightai/contracts';
import type {
  DataSource,
  Dataset,
  DatasetColumn,
  DatasetVersion,
  ImportJob,
} from '../../generated/prisma/client';

export function toVersionDto(version: DatasetVersion): DatasetVersionDto {
  return {
    id: version.id,
    versionNo: version.versionNo,
    origin: version.origin,
    rowCount: Number(version.rowCount),
    importJobId: version.importJobId,
    profileStatus: version.profileStatus,
    createdAt: version.createdAt.toISOString(),
  };
}

export function toColumnDto(column: DatasetColumn): DatasetColumnDto {
  return {
    ordinal: column.ordinal,
    name: column.name,
    originalName: column.originalName,
    dataType: column.dataType,
    inferredType: column.inferredType,
    typeConfidence: Number(column.typeConfidence),
    detectedFormat: column.detectedFormat,
    nonEmptyCount: Number(column.nonEmptyCount),
    invalidCount: Number(column.invalidCount),
  };
}

export function toDatasetSummary(
  dataset: Dataset & {
    activeVersion: (DatasetVersion & { _count: { columns: number } }) | null;
    importJobs: Pick<ImportJob, 'id' | 'status' | 'createdAt'>[];
  },
): DatasetSummary {
  const latest = dataset.importJobs[0];
  return {
    id: dataset.id,
    name: dataset.name,
    description: dataset.description,
    status: dataset.status,
    activeVersion: dataset.activeVersion ? toVersionDto(dataset.activeVersion) : null,
    columnCount: dataset.activeVersion?._count.columns ?? null,
    latestImport: latest
      ? { id: latest.id, status: latest.status, createdAt: latest.createdAt.toISOString() }
      : null,
    createdAt: dataset.createdAt.toISOString(),
    updatedAt: dataset.updatedAt.toISOString(),
  };
}

export function toImportJobDto(
  job: ImportJob & { dataSource: DataSource; version: Pick<DatasetVersion, 'id'> | null },
  requestedBy: { id: string; email: string; fullName: string } | null,
): ImportJobDto {
  return {
    id: job.id,
    datasetId: job.datasetId,
    dataSource: {
      id: job.dataSource.id,
      originalFilename: job.dataSource.originalFilename,
      fileFormat: job.dataSource.fileFormat === 'xlsx' ? 'xlsx' : 'csv',
      sizeBytes: Number(job.dataSource.sizeBytes),
    },
    status: job.status,
    options: job.options as Record<string, unknown>,
    rowsRead: job.rowsRead === null ? null : Number(job.rowsRead),
    warnings: (job.warnings as ImportJobDto['warnings']) ?? [],
    error: (job.error as ImportJobDto['error']) ?? null,
    versionId: job.version?.id ?? null,
    requestedBy,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}
