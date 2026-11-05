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
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  createDashboardRequestSchema,
  createWidgetRequestSchema,
  type DashboardDetail,
  dashboardDetailSchema,
  type DashboardSummary,
  dashboardSummarySchema,
  Permission,
  type SemanticQueryResult,
  semanticQueryResultSchema,
  updateDashboardRequestSchema,
  updateLayoutRequestSchema,
  updateWidgetRequestSchema,
} from '@insightai/contracts';
import { z } from 'zod';
import { RequirePermissions } from '../../platform/http/decorators';
import { CurrentTenant, type TenantContext } from '../../platform/http/request-context';
import { ApiZodBody, ApiZodResponse, zod } from '../../platform/http/zod';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboards')
@Controller()
export class DashboardController {
  constructor(private readonly dashboards: DashboardService) {}

  @Get('dashboards')
  @RequirePermissions(Permission.DASHBOARD_READ)
  @ApiZodResponse(200, z.array(dashboardSummarySchema))
  list(@CurrentTenant() ctx: TenantContext): Promise<DashboardSummary[]> {
    return this.dashboards.list(ctx);
  }

  @Post('dashboards')
  @RequirePermissions(Permission.DASHBOARD_WRITE)
  @ApiZodBody(createDashboardRequestSchema)
  @ApiZodResponse(201, dashboardDetailSchema)
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body(zod(createDashboardRequestSchema)) body: z.output<typeof createDashboardRequestSchema>,
  ): Promise<DashboardDetail> {
    return this.dashboards.create(ctx, body);
  }

  @Get('dashboards/:dashboardId')
  @RequirePermissions(Permission.DASHBOARD_READ)
  @ApiZodResponse(200, dashboardDetailSchema)
  get(
    @CurrentTenant() ctx: TenantContext,
    @Param('dashboardId', ParseUUIDPipe) id: string,
  ): Promise<DashboardDetail> {
    return this.dashboards.get(ctx, id);
  }

  @Patch('dashboards/:dashboardId')
  @RequirePermissions(Permission.DASHBOARD_WRITE)
  @ApiZodBody(updateDashboardRequestSchema)
  @ApiZodResponse(200, dashboardDetailSchema)
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('dashboardId', ParseUUIDPipe) id: string,
    @Body(zod(updateDashboardRequestSchema)) body: z.output<typeof updateDashboardRequestSchema>,
  ): Promise<DashboardDetail> {
    return this.dashboards.update(ctx, id, body);
  }

  @Delete('dashboards/:dashboardId')
  @HttpCode(204)
  @RequirePermissions(Permission.DASHBOARD_WRITE)
  remove(
    @CurrentTenant() ctx: TenantContext,
    @Param('dashboardId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.dashboards.remove(ctx, id);
  }

  /** Adds a widget from an IR, or pins an answer of one of the caller's AI conversations. */
  @Post('dashboards/:dashboardId/widgets')
  @RequirePermissions(Permission.DASHBOARD_WRITE)
  @ApiZodBody(createWidgetRequestSchema)
  @ApiZodResponse(201, dashboardDetailSchema)
  addWidget(
    @CurrentTenant() ctx: TenantContext,
    @Param('dashboardId', ParseUUIDPipe) id: string,
    @Body(zod(createWidgetRequestSchema)) body: z.output<typeof createWidgetRequestSchema>,
  ): Promise<DashboardDetail> {
    return this.dashboards.addWidget(ctx, id, body);
  }

  @Put('dashboards/:dashboardId/layout')
  @RequirePermissions(Permission.DASHBOARD_WRITE)
  @ApiZodBody(updateLayoutRequestSchema)
  @ApiZodResponse(200, dashboardDetailSchema)
  layout(
    @CurrentTenant() ctx: TenantContext,
    @Param('dashboardId', ParseUUIDPipe) id: string,
    @Body(zod(updateLayoutRequestSchema)) body: z.output<typeof updateLayoutRequestSchema>,
  ): Promise<DashboardDetail> {
    return this.dashboards.updateLayout(ctx, id, body.widgets);
  }

  @Patch('dashboard-widgets/:widgetId')
  @RequirePermissions(Permission.DASHBOARD_WRITE)
  @ApiZodBody(updateWidgetRequestSchema)
  @ApiZodResponse(200, dashboardDetailSchema)
  updateWidget(
    @CurrentTenant() ctx: TenantContext,
    @Param('widgetId', ParseUUIDPipe) id: string,
    @Body(zod(updateWidgetRequestSchema)) body: z.output<typeof updateWidgetRequestSchema>,
  ): Promise<DashboardDetail> {
    return this.dashboards.updateWidget(ctx, id, body);
  }

  @Delete('dashboard-widgets/:widgetId')
  @RequirePermissions(Permission.DASHBOARD_WRITE)
  @ApiZodResponse(200, dashboardDetailSchema)
  removeWidget(
    @CurrentTenant() ctx: TenantContext,
    @Param('widgetId', ParseUUIDPipe) id: string,
  ): Promise<DashboardDetail> {
    return this.dashboards.removeWidget(ctx, id);
  }

  /** Widget data with the viewer's permissions and access policies (never the author's). */
  @Post('dashboard-widgets/:widgetId/run')
  @HttpCode(200)
  @RequirePermissions(Permission.DASHBOARD_READ, Permission.SEMANTIC_QUERY)
  @ApiZodResponse(200, semanticQueryResultSchema)
  run(
    @CurrentTenant() ctx: TenantContext,
    @Param('widgetId', ParseUUIDPipe) id: string,
  ): Promise<SemanticQueryResult> {
    return this.dashboards.runWidget(ctx, id);
  }
}
