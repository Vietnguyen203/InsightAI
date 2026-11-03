import { stat, unlink } from 'node:fs/promises';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ImportJob as ImportJobDto, ImportOptions } from '@insightai/contracts';
import type { Queue } from 'bullmq';
import type { Prisma } from '../../generated/prisma/client';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.module';
import { randomBase36, uuidv7 } from '../../platform/crypto/ids';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors/app-error';
import type { TenantContext } from '../../platform/http/request-context';
import { type DbTransaction, PrismaService } from '../../platform/prisma/prisma.service';
import { ImportJobName, type ImportJobData, QueueName } from '../../platform/queue/queues';
import { StorageService } from '../../platform/storage/storage.service';
import { AuditService } from '../audit/audit.service';
import { importLimits } from '../import/import-limits';
import { detectFileFormat, readHead } from '../import/parsing/file-format';
import { ImportError } from '../import/parsing/import-error';
import { toImportJobDto } from './dataset-mappers';

export interface UploadedFile {
  path: string;
  originalname: string;
  size: number;
}

const jobInclude = { dataSource: true, version: { select: { id: true } } } as const;

/**
 * API side of imports: validates and stores the uploaded file, records the job, enqueues it.
 * The heavy lifting happens in the worker (ImportRunnerService).
 */
@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    @InjectQueue(QueueName.IMPORT) private readonly queue: Queue<ImportJobData>,
  ) {}

  async upload(
    ctx: TenantContext,
    datasetId: string,
    file: UploadedFile,
    options: ImportOptions,
  ): Promise<ImportJobDto> {
    try {
      const { size } = await stat(file.path);
      if (size > importLimits(this.config).maxFileBytes) {
        throw new ValidationError('The file is larger than the upload limit');
      }
      // Content sniffing before anything is stored: the extension alone is not trusted.
      const head = await readHead(file.path);
      let fileFormat: 'csv' | 'xlsx';
      try {
        fileFormat = detectFileFormat(file.originalname, head);
      } catch (error) {
        if (error instanceof ImportError) throw new ValidationError(error.message);
        throw error;
      }

      await this.assertImportable(ctx, datasetId);

      const dataSourceId = uuidv7();
      const storageKey = `org/${ctx.organizationId}/uploads/${dataSourceId}`;
      const { sha256 } = await this.storage.uploadFile(storageKey, file.path);

      const job = await this.prisma.runInContext(
        { organizationId: ctx.organizationId, userId: ctx.userId },
        async (tx) => {
          await tx.dataSource.create({
            data: {
              id: dataSourceId,
              organizationId: ctx.organizationId,
              storageKey,
              originalFilename: file.originalname.slice(0, 255),
              fileFormat,
              sizeBytes: BigInt(size),
              sha256,
              uploadedById: ctx.userId,
            },
          });
          return this.createJob(tx, ctx, datasetId, dataSourceId, options);
        },
      );
      await this.enqueue(ctx.organizationId, job.id);
      return job;
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }

  /** Imports a previously uploaded file again, e.g. with different options or column types. */
  async reimport(
    ctx: TenantContext,
    datasetId: string,
    dataSourceId: string,
    options: ImportOptions,
  ): Promise<ImportJobDto> {
    await this.assertImportable(ctx, datasetId);
    const job = await this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const source = await tx.dataSource.findUnique({ where: { id: dataSourceId } });
        if (!source) throw new NotFoundError('Uploaded file not found');
        return this.createJob(tx, ctx, datasetId, dataSourceId, options);
      },
    );
    await this.enqueue(ctx.organizationId, job.id);
    return job;
  }

  async list(ctx: TenantContext, datasetId: string): Promise<ImportJobDto[]> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const dataset = await tx.dataset.findUnique({ where: { id: datasetId } });
      if (!dataset) throw new NotFoundError('Dataset not found');
      const jobs = await tx.importJob.findMany({
        where: { datasetId },
        include: jobInclude,
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      const users = await tx.user.findMany({
        where: { id: { in: [...new Set(jobs.map((j) => j.requestedById))] } },
        select: { id: true, email: true, fullName: true },
      });
      const userById = new Map(users.map((u) => [u.id, u]));
      return jobs.map((job) => toImportJobDto(job, userById.get(job.requestedById) ?? null));
    });
  }

  async get(ctx: TenantContext, importJobId: string): Promise<ImportJobDto> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const job = await tx.importJob.findUnique({
        where: { id: importJobId },
        include: jobInclude,
      });
      if (!job) throw new NotFoundError('Import not found');
      const user = await tx.user.findUnique({
        where: { id: job.requestedById },
        select: { id: true, email: true, fullName: true },
      });
      return toImportJobDto(job, user);
    });
  }

  private async assertImportable(ctx: TenantContext, datasetId: string): Promise<void> {
    const dataset = await this.prisma.runInTenant(ctx.organizationId, (tx) =>
      tx.dataset.findUnique({ where: { id: datasetId } }),
    );
    if (!dataset) throw new NotFoundError('Dataset not found');
    if (dataset.archivedAt) throw new ConflictError('Archived datasets cannot receive new data');
  }

  private async createJob(
    tx: DbTransaction,
    ctx: TenantContext,
    datasetId: string,
    dataSourceId: string,
    options: ImportOptions,
  ): Promise<ImportJobDto> {
    const job = await tx.importJob.create({
      data: {
        id: uuidv7(),
        organizationId: ctx.organizationId,
        datasetId,
        dataSourceId,
        options: options,
        tableKey: randomBase36(8),
        requestedById: ctx.userId,
      },
      include: jobInclude,
    });
    await this.audit.record(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'dataset.import_requested',
      resourceType: 'dataset',
      resourceId: datasetId,
      changes: {
        importJobId: job.id,
        file: job.dataSource.originalFilename,
        options: options as Prisma.InputJsonValue,
      },
      meta: ctx,
    });
    const user = await tx.user.findUnique({
      where: { id: ctx.userId },
      select: { id: true, email: true, fullName: true },
    });
    return toImportJobDto(job, user);
  }

  /**
   * The job id equals the import job id, so enqueueing twice is harmless. If Redis is down the
   * job row stays PENDING (visible to the user) and the error propagates.
   */
  private async enqueue(organizationId: string, importJobId: string): Promise<void> {
    try {
      await this.queue.add(
        ImportJobName.RUN,
        { organizationId, importJobId },
        { jobId: importJobId },
      );
    } catch (error) {
      this.logger.error({ err: error, importJobId }, 'Could not enqueue import job');
      throw error;
    }
  }
}
