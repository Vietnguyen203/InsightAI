import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type CleaningJob,
  cleaningJobSchema,
  type CleaningPreview,
  cleaningPreviewSchema,
  cleaningRequestSchema,
  type CleaningSuggestions,
  cleaningSuggestionsSchema,
  Permission,
} from '@insightai/contracts';
import { z } from 'zod';
import { RequirePermissions } from '../../platform/http/decorators';
import { CurrentTenant, type TenantContext } from '../../platform/http/request-context';
import { ApiZodBody, ApiZodQuery, ApiZodResponse, zod } from '../../platform/http/zod';
import { CleaningSuggestionService } from './cleaning-suggestion.service';
import { CleaningService } from './cleaning.service';

const versionQuerySchema = z.object({ versionId: z.uuid().optional() });

@ApiTags('cleaning')
@Controller()
export class CleaningController {
  constructor(
    private readonly cleaning: CleaningService,
    private readonly suggestions: CleaningSuggestionService,
  ) {}

  /** Rule-based suggestions for a version (default: active); nothing is applied. */
  @Get('datasets/:datasetId/cleaning/suggestions')
  @RequirePermissions(Permission.QUALITY_READ)
  @ApiZodQuery(versionQuerySchema)
  @ApiZodResponse(200, cleaningSuggestionsSchema)
  suggest(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
    @Query(zod(versionQuerySchema)) query: z.output<typeof versionQuerySchema>,
  ): Promise<CleaningSuggestions> {
    return this.suggestions.suggest(ctx, datasetId, query.versionId);
  }

  /** Exact impact per operation and before/after sample; runs read-only, writes nothing. */
  @Post('datasets/:datasetId/cleaning/preview')
  @HttpCode(200)
  @RequirePermissions(Permission.QUALITY_WRITE)
  @ApiZodBody(cleaningRequestSchema)
  @ApiZodResponse(200, cleaningPreviewSchema)
  preview(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
    @Body(zod(cleaningRequestSchema)) body: z.output<typeof cleaningRequestSchema>,
  ): Promise<CleaningPreview> {
    return this.cleaning.preview(ctx, datasetId, body);
  }

  /** Applies the operations in the background; the result is a new, not yet active version. */
  @Post('datasets/:datasetId/cleaning-jobs')
  @HttpCode(202)
  @RequirePermissions(Permission.QUALITY_APPLY_CLEANING)
  @ApiZodBody(cleaningRequestSchema)
  @ApiZodResponse(202, cleaningJobSchema)
  apply(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
    @Body(zod(cleaningRequestSchema)) body: z.output<typeof cleaningRequestSchema>,
  ): Promise<CleaningJob> {
    return this.cleaning.apply(ctx, datasetId, body);
  }

  @Get('datasets/:datasetId/cleaning-jobs')
  @RequirePermissions(Permission.QUALITY_READ)
  @ApiZodResponse(200, z.array(cleaningJobSchema))
  list(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
  ): Promise<CleaningJob[]> {
    return this.cleaning.list(ctx, datasetId);
  }

  @Get('cleaning-jobs/:jobId')
  @RequirePermissions(Permission.QUALITY_READ)
  @ApiZodResponse(200, cleaningJobSchema)
  get(
    @CurrentTenant() ctx: TenantContext,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ): Promise<CleaningJob> {
    return this.cleaning.get(ctx, jobId);
  }
}
