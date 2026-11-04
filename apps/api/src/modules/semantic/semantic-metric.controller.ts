import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type Catalog,
  catalogQuerySchema,
  catalogSchema,
  createMetricRequestSchema,
  createMetricVersionRequestSchema,
  createSynonymRequestSchema,
  type Metric,
  type MetricDetail,
  metricDetailSchema,
  metricSchema,
  Permission,
  type Synonym,
  synonymSchema,
  updateMetricVersionRequestSchema,
} from '@insightai/contracts';
import { z } from 'zod';
import { RequirePermissions } from '../../platform/http/decorators';
import { CurrentTenant, type TenantContext } from '../../platform/http/request-context';
import { ApiZodBody, ApiZodQuery, ApiZodResponse, zod } from '../../platform/http/zod';
import { SemanticMetricService } from './semantic-metric.service';

@ApiTags('metrics')
@Controller()
export class SemanticMetricController {
  constructor(private readonly metrics: SemanticMetricService) {}

  @Get('semantic-models/:modelId/metrics')
  @RequirePermissions(Permission.SEMANTIC_READ)
  @ApiZodResponse(200, z.array(metricSchema))
  list(
    @CurrentTenant() ctx: TenantContext,
    @Param('modelId', ParseUUIDPipe) modelId: string,
  ): Promise<Metric[]> {
    return this.metrics.list(ctx, modelId);
  }

  /** Creates the metric with a first draft version. */
  @Post('semantic-models/:modelId/metrics')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodBody(createMetricRequestSchema)
  @ApiZodResponse(201, metricDetailSchema)
  create(
    @CurrentTenant() ctx: TenantContext,
    @Param('modelId', ParseUUIDPipe) modelId: string,
    @Body(zod(createMetricRequestSchema)) body: z.output<typeof createMetricRequestSchema>,
  ): Promise<MetricDetail> {
    return this.metrics.create(ctx, modelId, body);
  }

  @Get('metrics/:metricId')
  @RequirePermissions(Permission.SEMANTIC_READ)
  @ApiZodResponse(200, metricDetailSchema)
  get(
    @CurrentTenant() ctx: TenantContext,
    @Param('metricId', ParseUUIDPipe) metricId: string,
  ): Promise<MetricDetail> {
    return this.metrics.get(ctx, metricId);
  }

  @Post('metrics/:metricId/versions')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodBody(createMetricVersionRequestSchema)
  @ApiZodResponse(201, metricDetailSchema)
  createVersion(
    @CurrentTenant() ctx: TenantContext,
    @Param('metricId', ParseUUIDPipe) metricId: string,
    @Body(zod(createMetricVersionRequestSchema))
    body: z.output<typeof createMetricVersionRequestSchema>,
  ): Promise<MetricDetail> {
    return this.metrics.createVersion(ctx, metricId, body);
  }

  @Patch('metric-versions/:versionId')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodBody(updateMetricVersionRequestSchema)
  @ApiZodResponse(200, metricDetailSchema)
  updateVersion(
    @CurrentTenant() ctx: TenantContext,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body(zod(updateMetricVersionRequestSchema))
    body: z.output<typeof updateMetricVersionRequestSchema>,
  ): Promise<MetricDetail> {
    return this.metrics.updateVersion(ctx, versionId, body);
  }

  /** Discards a draft; returns null when the metric had no other version (it is removed). */
  @Delete('metric-versions/:versionId')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodResponse(200, metricDetailSchema.nullable())
  deleteDraft(
    @CurrentTenant() ctx: TenantContext,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ): Promise<MetricDetail | null> {
    return this.metrics.deleteDraft(ctx, versionId);
  }

  /** Plans the draft against the published model (422 with a reason) and publishes it. */
  @Post('metric-versions/:versionId/publish')
  @HttpCode(200)
  @RequirePermissions(Permission.SEMANTIC_PUBLISH)
  @ApiZodResponse(200, metricDetailSchema)
  publish(
    @CurrentTenant() ctx: TenantContext,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ): Promise<MetricDetail> {
    return this.metrics.publish(ctx, versionId);
  }

  @Post('metrics/:metricId/deprecate')
  @HttpCode(200)
  @RequirePermissions(Permission.SEMANTIC_PUBLISH)
  @ApiZodResponse(200, metricDetailSchema)
  deprecate(
    @CurrentTenant() ctx: TenantContext,
    @Param('metricId', ParseUUIDPipe) metricId: string,
  ): Promise<MetricDetail> {
    return this.metrics.setStatus(ctx, metricId, 'DEPRECATED');
  }

  @Post('metrics/:metricId/restore')
  @HttpCode(200)
  @RequirePermissions(Permission.SEMANTIC_PUBLISH)
  @ApiZodResponse(200, metricDetailSchema)
  restore(
    @CurrentTenant() ctx: TenantContext,
    @Param('metricId', ParseUUIDPipe) metricId: string,
  ): Promise<MetricDetail> {
    return this.metrics.setStatus(ctx, metricId, 'ACTIVE');
  }

  @Get('semantic-models/:modelId/synonyms')
  @RequirePermissions(Permission.SEMANTIC_READ)
  @ApiZodResponse(200, z.array(synonymSchema))
  listSynonyms(
    @CurrentTenant() ctx: TenantContext,
    @Param('modelId', ParseUUIDPipe) modelId: string,
  ): Promise<Synonym[]> {
    return this.metrics.listSynonyms(ctx, modelId);
  }

  @Post('semantic-models/:modelId/synonyms')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodBody(createSynonymRequestSchema)
  @ApiZodResponse(201, synonymSchema)
  addSynonym(
    @CurrentTenant() ctx: TenantContext,
    @Param('modelId', ParseUUIDPipe) modelId: string,
    @Body(zod(createSynonymRequestSchema)) body: z.output<typeof createSynonymRequestSchema>,
  ): Promise<Synonym> {
    return this.metrics.addSynonym(ctx, modelId, body);
  }

  @Delete('semantic-synonyms/:synonymId')
  @HttpCode(204)
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  removeSynonym(
    @CurrentTenant() ctx: TenantContext,
    @Param('synonymId', ParseUUIDPipe) synonymId: string,
  ): Promise<void> {
    return this.metrics.removeSynonym(ctx, synonymId);
  }

  /** Metrics and dimensions the caller may query (policy-filtered), with synonyms. */
  @Get('catalog')
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  @ApiZodQuery(catalogQuerySchema)
  @ApiZodResponse(200, catalogSchema)
  catalog(
    @CurrentTenant() ctx: TenantContext,
    @Query(zod(catalogQuerySchema)) query: z.output<typeof catalogQuerySchema>,
  ): Promise<Catalog> {
    return this.metrics.catalog(ctx, query.model);
  }
}
