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
  createRuleRequestSchema,
  issuesQuerySchema,
  type Page,
  pageSchema,
  Permission,
  type QualityCheckDetail,
  qualityCheckDetailSchema,
  type QualityCheckSummary,
  qualityCheckSummarySchema,
  type QualityIssue,
  qualityIssueSchema,
  type QualityRule,
  qualityRuleSchema,
  updateRuleRequestSchema,
  validateExpressionRequestSchema,
  type ValidateExpressionResponse,
  validateExpressionResponseSchema,
} from '@insightai/contracts';
import { z } from 'zod';
import { RequirePermissions } from '../../platform/http/decorators';
import { CurrentTenant, type TenantContext } from '../../platform/http/request-context';
import { ApiZodBody, ApiZodQuery, ApiZodResponse, zod } from '../../platform/http/zod';
import { QualityCheckService } from './quality-check.service';
import { QualityRuleService } from './quality-rule.service';

const versionQuerySchema = z.object({ versionId: z.uuid().optional() });

@ApiTags('quality')
@Controller()
export class QualityController {
  constructor(
    private readonly rules: QualityRuleService,
    private readonly checks: QualityCheckService,
  ) {}

  @Get('datasets/:datasetId/quality-rules')
  @RequirePermissions(Permission.QUALITY_READ)
  @ApiZodResponse(200, z.array(qualityRuleSchema))
  listRules(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
  ): Promise<QualityRule[]> {
    return this.rules.list(ctx, datasetId);
  }

  @Post('datasets/:datasetId/quality-rules')
  @RequirePermissions(Permission.QUALITY_WRITE)
  @ApiZodBody(createRuleRequestSchema)
  @ApiZodResponse(201, qualityRuleSchema)
  createRule(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
    @Body(zod(createRuleRequestSchema)) body: z.output<typeof createRuleRequestSchema>,
  ): Promise<QualityRule> {
    return this.rules.create(ctx, datasetId, body);
  }

  @Patch('quality-rules/:ruleId')
  @RequirePermissions(Permission.QUALITY_WRITE)
  @ApiZodBody(updateRuleRequestSchema)
  @ApiZodResponse(200, qualityRuleSchema)
  updateRule(
    @CurrentTenant() ctx: TenantContext,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body(zod(updateRuleRequestSchema)) body: z.output<typeof updateRuleRequestSchema>,
  ): Promise<QualityRule> {
    return this.rules.update(ctx, ruleId, body);
  }

  @Delete('quality-rules/:ruleId')
  @HttpCode(204)
  @RequirePermissions(Permission.QUALITY_WRITE)
  deleteRule(
    @CurrentTenant() ctx: TenantContext,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
  ): Promise<void> {
    return this.rules.remove(ctx, ruleId);
  }

  /** Live check of a consistency expression for the rule editor. */
  @Post('datasets/:datasetId/expressions/validate')
  @HttpCode(200)
  @RequirePermissions(Permission.QUALITY_READ)
  @ApiZodBody(validateExpressionRequestSchema)
  @ApiZodResponse(200, validateExpressionResponseSchema)
  validateExpression(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
    @Body(zod(validateExpressionRequestSchema))
    body: z.output<typeof validateExpressionRequestSchema>,
  ): Promise<ValidateExpressionResponse> {
    return this.rules.validateExpression(ctx, datasetId, body.expr);
  }

  @Post('datasets/:datasetId/quality-checks')
  @HttpCode(202)
  @RequirePermissions(Permission.QUALITY_WRITE)
  @ApiZodQuery(versionQuerySchema)
  @ApiZodResponse(202, qualityCheckSummarySchema)
  runCheck(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
    @Query(zod(versionQuerySchema)) query: z.output<typeof versionQuerySchema>,
  ): Promise<QualityCheckSummary> {
    return this.checks.requestManual(ctx, datasetId, query.versionId);
  }

  @Get('datasets/:datasetId/quality-checks')
  @RequirePermissions(Permission.QUALITY_READ)
  @ApiZodResponse(200, z.array(qualityCheckSummarySchema))
  listChecks(
    @CurrentTenant() ctx: TenantContext,
    @Param('datasetId', ParseUUIDPipe) datasetId: string,
  ): Promise<QualityCheckSummary[]> {
    return this.checks.list(ctx, datasetId);
  }

  @Get('quality-checks/:checkId')
  @RequirePermissions(Permission.QUALITY_READ)
  @ApiZodResponse(200, qualityCheckDetailSchema)
  getCheck(
    @CurrentTenant() ctx: TenantContext,
    @Param('checkId', ParseUUIDPipe) checkId: string,
  ): Promise<QualityCheckDetail> {
    return this.checks.get(ctx, checkId);
  }

  @Get('quality-checks/:checkId/results/:resultId/issues')
  @RequirePermissions(Permission.QUALITY_READ)
  @ApiZodQuery(issuesQuerySchema)
  @ApiZodResponse(200, pageSchema(qualityIssueSchema))
  issues(
    @CurrentTenant() ctx: TenantContext,
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @Param('resultId', ParseUUIDPipe) resultId: string,
    @Query(zod(issuesQuerySchema)) query: z.output<typeof issuesQuerySchema>,
  ): Promise<Page<QualityIssue>> {
    return this.checks.issues(ctx, checkId, resultId, query);
  }
}
