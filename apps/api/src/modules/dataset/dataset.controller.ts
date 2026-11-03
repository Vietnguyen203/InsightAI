import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  createDatasetRequestSchema,
  type DatasetDetail,
  datasetDetailSchema,
  type DatasetSummary,
  datasetSummarySchema,
  IMPORT_LIMITS,
  type ImportJob,
  importJobSchema,
  importOptionsSchema,
  Permission,
  reimportRequestSchema,
  type RowsPage,
  rowsPageSchema,
  rowsQuerySchema,
  updateDatasetRequestSchema,
} from '@insightai/contracts';
import { z } from 'zod';
import { ValidationError } from '../../platform/errors/app-error';
import { RequirePermissions } from '../../platform/http/decorators';
import { CurrentTenant, type TenantContext } from '../../platform/http/request-context';
import { ApiZodBody, ApiZodQuery, ApiZodResponse, zod } from '../../platform/http/zod';
import { DatasetService } from './dataset.service';
import { ImportService, type UploadedFile as StoredUpload } from './import.service';

/** Multipart `options` field: a JSON object validated against importOptionsSchema. */
const multipartOptionsSchema = z
  .string()
  .max(10_000)
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === '') return {};
    try {
      return JSON.parse(value) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'options must be a JSON object' });
      return z.NEVER;
    }
  })
  .pipe(importOptionsSchema);

@ApiTags('datasets')
@Controller('datasets')
export class DatasetController {
  constructor(
    private readonly datasets: DatasetService,
    private readonly imports: ImportService,
  ) {}

  @Get()
  @RequirePermissions(Permission.DATASET_READ)
  @ApiZodResponse(200, z.array(datasetSummarySchema))
  list(@CurrentTenant() ctx: TenantContext): Promise<DatasetSummary[]> {
    return this.datasets.list(ctx);
  }

  @Post()
  @RequirePermissions(Permission.DATASET_WRITE)
  @ApiZodBody(createDatasetRequestSchema)
  @ApiZodResponse(201, datasetSummarySchema)
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body(zod(createDatasetRequestSchema)) body: z.output<typeof createDatasetRequestSchema>,
  ): Promise<DatasetSummary> {
    return this.datasets.create(ctx, body);
  }

  @Get(':datasetId')
  @RequirePermissions(Permission.DATASET_READ)
  @ApiZodResponse(200, datasetDetailSchema)
  get(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
  ): Promise<DatasetDetail> {
    return this.datasets.get(ctx, datasetId);
  }

  @Patch(':datasetId')
  @RequirePermissions(Permission.DATASET_WRITE)
  @ApiZodBody(updateDatasetRequestSchema)
  @ApiZodResponse(200, datasetSummarySchema)
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
    @Body(zod(updateDatasetRequestSchema)) body: z.output<typeof updateDatasetRequestSchema>,
  ): Promise<DatasetSummary> {
    return this.datasets.update(ctx, datasetId, body);
  }

  /** Hides the dataset. Data and history are kept (nothing is deleted). */
  @Post(':datasetId/archive')
  @HttpCode(204)
  @RequirePermissions(Permission.DATASET_WRITE)
  archive(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
  ): Promise<void> {
    return this.datasets.archive(ctx, datasetId);
  }

  @Get(':datasetId/rows')
  @RequirePermissions(Permission.DATASET_READ)
  @ApiZodQuery(rowsQuerySchema)
  @ApiZodResponse(200, rowsPageSchema)
  rows(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
    @Query(zod(rowsQuerySchema)) query: z.output<typeof rowsQuerySchema>,
  ): Promise<RowsPage> {
    return this.datasets.rows(ctx, datasetId, query);
  }

  @Get(':datasetId/imports')
  @RequirePermissions(Permission.DATASET_READ)
  @ApiZodResponse(200, z.array(importJobSchema))
  listImports(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
  ): Promise<ImportJob[]> {
    return this.imports.list(ctx, datasetId);
  }

  /** Upload a CSV/XLSX file; the import runs in the background (poll GET /imports/:id). */
  @Post(':datasetId/imports')
  @HttpCode(202)
  @RequirePermissions(Permission.DATASET_WRITE)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: `${IMPORT_LIMITS.acceptedExtensions.join(', ')} up to ${IMPORT_LIMITS.maxFileBytes / 1024 / 1024} MB`,
        },
        options: { type: 'string', description: 'JSON object, see ImportOptions' },
      },
    },
  })
  @ApiZodResponse(202, importJobSchema)
  upload(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
    @UploadedFile() file: StoredUpload | undefined,
    @Body('options', zod(multipartOptionsSchema)) options: z.output<typeof multipartOptionsSchema>,
  ): Promise<ImportJob> {
    if (!file) throw new ValidationError('A file is required (multipart field "file")');
    return this.imports.upload(ctx, datasetId, file, options);
  }

  /** Re-runs an import from an already uploaded file, e.g. with column type overrides. */
  @Post(':datasetId/reimports')
  @HttpCode(202)
  @RequirePermissions(Permission.DATASET_WRITE)
  @ApiZodBody(reimportRequestSchema)
  @ApiZodResponse(202, importJobSchema)
  reimport(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
    @Body(zod(reimportRequestSchema)) body: z.output<typeof reimportRequestSchema>,
  ): Promise<ImportJob> {
    return this.imports.reimport(ctx, datasetId, body.dataSourceId, body.options);
  }
}

@ApiTags('datasets')
@Controller('imports')
export class ImportController {
  constructor(private readonly imports: ImportService) {}

  @Get(':importJobId')
  @RequirePermissions(Permission.DATASET_READ)
  @ApiZodResponse(200, importJobSchema)
  get(
    @CurrentTenant() ctx: TenantContext,
    @Param('importJobId', ParseUUIDPipe) importJobId: string,
  ): Promise<ImportJob> {
    return this.imports.get(ctx, importJobId);
  }
}
