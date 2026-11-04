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
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  createDimensionRequestSchema,
  createEntityRequestSchema,
  createMeasureRequestSchema,
  createRelationshipRequestSchema,
  createSemanticModelRequestSchema,
  Permission,
  type SemanticModelDetail,
  semanticModelDetailSchema,
  type SemanticModelSummary,
  semanticModelSummarySchema,
  updateDimensionRequestSchema,
  updateEntityRequestSchema,
  updateMeasureRequestSchema,
  updateRelationshipRequestSchema,
  updateSemanticModelRequestSchema,
} from '@insightai/contracts';
import { z } from 'zod';
import { RequirePermissions } from '../../platform/http/decorators';
import { CurrentTenant, type TenantContext } from '../../platform/http/request-context';
import { ApiZodBody, ApiZodResponse, zod } from '../../platform/http/zod';
import { SemanticModelService } from './semantic-model.service';
import { SemanticValidationService } from './semantic-validation.service';

/** Every write returns the whole model as it is afterwards (the editor re-renders from it). */
@ApiTags('semantic')
@Controller()
export class SemanticController {
  constructor(
    private readonly models: SemanticModelService,
    private readonly validation: SemanticValidationService,
  ) {}

  @Get('semantic-models')
  @RequirePermissions(Permission.SEMANTIC_READ)
  @ApiZodResponse(200, z.array(semanticModelSummarySchema))
  list(@CurrentTenant() ctx: TenantContext): Promise<SemanticModelSummary[]> {
    return this.models.list(ctx);
  }

  @Post('semantic-models')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodBody(createSemanticModelRequestSchema)
  @ApiZodResponse(201, semanticModelDetailSchema)
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body(zod(createSemanticModelRequestSchema))
    body: z.output<typeof createSemanticModelRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.models.create(ctx, body);
  }

  @Get('semantic-models/:modelId')
  @RequirePermissions(Permission.SEMANTIC_READ)
  @ApiZodResponse(200, semanticModelDetailSchema)
  get(
    @CurrentTenant() ctx: TenantContext,
    @Param('modelId', ParseUUIDPipe) modelId: string,
  ): Promise<SemanticModelDetail> {
    return this.models.get(ctx, modelId);
  }

  @Patch('semantic-models/:modelId')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodBody(updateSemanticModelRequestSchema)
  @ApiZodResponse(200, semanticModelDetailSchema)
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('modelId', ParseUUIDPipe) modelId: string,
    @Body(zod(updateSemanticModelRequestSchema))
    body: z.output<typeof updateSemanticModelRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.models.update(ctx, modelId, body);
  }

  /** Checks the draft (columns, types, expressions, keys, relationships) and stores the report. */
  @Post('semantic-models/:modelId/validate')
  @HttpCode(200)
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodResponse(200, semanticModelDetailSchema)
  validate(
    @CurrentTenant() ctx: TenantContext,
    @Param('modelId', ParseUUIDPipe) modelId: string,
  ): Promise<SemanticModelDetail> {
    return this.validation.validate(ctx, modelId);
  }

  /** Validates and freezes the draft as the next published revision (409 on validation errors). */
  @Post('semantic-models/:modelId/publish')
  @HttpCode(200)
  @RequirePermissions(Permission.SEMANTIC_PUBLISH)
  @ApiZodResponse(200, semanticModelDetailSchema)
  publish(
    @CurrentTenant() ctx: TenantContext,
    @Param('modelId', ParseUUIDPipe) modelId: string,
  ): Promise<SemanticModelDetail> {
    return this.validation.publish(ctx, modelId);
  }

  // ─── Entities ──────────────────────────────────────────────────────────────

  @Post('semantic-models/:modelId/entities')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodBody(createEntityRequestSchema)
  @ApiZodResponse(201, semanticModelDetailSchema)
  createEntity(
    @CurrentTenant() ctx: TenantContext,
    @Param('modelId', ParseUUIDPipe) modelId: string,
    @Body(zod(createEntityRequestSchema)) body: z.output<typeof createEntityRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.models.createEntity(ctx, modelId, body);
  }

  @Patch('semantic-entities/:entityId')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodBody(updateEntityRequestSchema)
  @ApiZodResponse(200, semanticModelDetailSchema)
  updateEntity(
    @CurrentTenant() ctx: TenantContext,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Body(zod(updateEntityRequestSchema)) body: z.output<typeof updateEntityRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.models.updateEntity(ctx, entityId, body);
  }

  @Delete('semantic-entities/:entityId')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodResponse(200, semanticModelDetailSchema)
  deleteEntity(
    @CurrentTenant() ctx: TenantContext,
    @Param('entityId', ParseUUIDPipe) entityId: string,
  ): Promise<SemanticModelDetail> {
    return this.models.deleteEntity(ctx, entityId);
  }

  // ─── Dimensions ────────────────────────────────────────────────────────────

  @Post('semantic-entities/:entityId/dimensions')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodBody(createDimensionRequestSchema)
  @ApiZodResponse(201, semanticModelDetailSchema)
  createDimension(
    @CurrentTenant() ctx: TenantContext,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Body(zod(createDimensionRequestSchema)) body: z.output<typeof createDimensionRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.models.createDimension(ctx, entityId, body);
  }

  @Patch('semantic-dimensions/:dimensionId')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodBody(updateDimensionRequestSchema)
  @ApiZodResponse(200, semanticModelDetailSchema)
  updateDimension(
    @CurrentTenant() ctx: TenantContext,
    @Param('dimensionId', ParseUUIDPipe) dimensionId: string,
    @Body(zod(updateDimensionRequestSchema)) body: z.output<typeof updateDimensionRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.models.updateDimension(ctx, dimensionId, body);
  }

  @Delete('semantic-dimensions/:dimensionId')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodResponse(200, semanticModelDetailSchema)
  deleteDimension(
    @CurrentTenant() ctx: TenantContext,
    @Param('dimensionId', ParseUUIDPipe) dimensionId: string,
  ): Promise<SemanticModelDetail> {
    return this.models.deleteDimension(ctx, dimensionId);
  }

  // ─── Measures ──────────────────────────────────────────────────────────────

  @Post('semantic-entities/:entityId/measures')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodBody(createMeasureRequestSchema)
  @ApiZodResponse(201, semanticModelDetailSchema)
  createMeasure(
    @CurrentTenant() ctx: TenantContext,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Body(zod(createMeasureRequestSchema)) body: z.output<typeof createMeasureRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.models.createMeasure(ctx, entityId, body);
  }

  @Patch('semantic-measures/:measureId')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodBody(updateMeasureRequestSchema)
  @ApiZodResponse(200, semanticModelDetailSchema)
  updateMeasure(
    @CurrentTenant() ctx: TenantContext,
    @Param('measureId', ParseUUIDPipe) measureId: string,
    @Body(zod(updateMeasureRequestSchema)) body: z.output<typeof updateMeasureRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.models.updateMeasure(ctx, measureId, body);
  }

  @Delete('semantic-measures/:measureId')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodResponse(200, semanticModelDetailSchema)
  deleteMeasure(
    @CurrentTenant() ctx: TenantContext,
    @Param('measureId', ParseUUIDPipe) measureId: string,
  ): Promise<SemanticModelDetail> {
    return this.models.deleteMeasure(ctx, measureId);
  }

  // ─── Relationships ─────────────────────────────────────────────────────────

  @Post('semantic-models/:modelId/relationships')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodBody(createRelationshipRequestSchema)
  @ApiZodResponse(201, semanticModelDetailSchema)
  createRelationship(
    @CurrentTenant() ctx: TenantContext,
    @Param('modelId', ParseUUIDPipe) modelId: string,
    @Body(zod(createRelationshipRequestSchema))
    body: z.output<typeof createRelationshipRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.models.createRelationship(ctx, modelId, body);
  }

  @Patch('semantic-relationships/:relationshipId')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodBody(updateRelationshipRequestSchema)
  @ApiZodResponse(200, semanticModelDetailSchema)
  updateRelationship(
    @CurrentTenant() ctx: TenantContext,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
    @Body(zod(updateRelationshipRequestSchema))
    body: z.output<typeof updateRelationshipRequestSchema>,
  ): Promise<SemanticModelDetail> {
    return this.models.updateRelationship(ctx, relationshipId, body);
  }

  @Delete('semantic-relationships/:relationshipId')
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodResponse(200, semanticModelDetailSchema)
  deleteRelationship(
    @CurrentTenant() ctx: TenantContext,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
  ): Promise<SemanticModelDetail> {
    return this.models.deleteRelationship(ctx, relationshipId);
  }
}
