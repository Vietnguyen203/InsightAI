import { Injectable } from '@nestjs/common';
import {
  type Answer,
  type ChartSpec,
  chartSpecSchema,
  type DashboardDetail,
  type DashboardSummary,
  type DashboardWidget as DashboardWidgetDto,
  MAX_DASHBOARDS_PER_ORG,
  MAX_WIDGETS_PER_DASHBOARD,
  type SemanticQueryParsed,
  semanticQuerySchema,
  type SemanticQueryResult,
  SystemRole,
  type WidgetPosition,
  widgetPositionSchema,
} from '@insightai/contracts';
import { uuidv7 } from '../../platform/crypto/ids';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors/app-error';
import type { TenantContext } from '../../platform/http/request-context';
import { type DbTransaction, PrismaService } from '../../platform/prisma/prisma.service';
import { type Dashboard, type DashboardWidget, Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { QueryEngineService } from '../query-engine/query-engine.service';

type WidgetInput =
  | { title: string; query: SemanticQueryParsed; chart: ChartSpec; position?: WidgetPosition }
  | { fromMessageId: string; title?: string; position?: WidgetPosition };

const DEFAULT_SIZE = { w: 6, h: 4 };

/**
 * Dashboards (docs/PHASE6_AUDIT.md §3). Visibility is enforced by RLS (PRIVATE rows exist only
 * for their owner); who may edit is decided here: the owner, or the organization's owner/admin
 * for ORG dashboards. Widgets store IR only and always run as the viewer.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: QueryEngineService,
    private readonly audit: AuditService,
  ) {}

  /** RLS needs the user for dashboard visibility. */
  private run<T>(ctx: TenantContext, work: (tx: DbTransaction) => Promise<T>) {
    return this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      work,
    );
  }

  async list(ctx: TenantContext): Promise<DashboardSummary[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx.dashboard.findMany({
        include: { _count: { select: { widgets: true } } },
        orderBy: { updatedAt: 'desc' },
      });
      const owners = await ownerNames(tx, rows);
      return rows.map((d) => toSummary(ctx, d, d._count.widgets, owners));
    });
  }

  async get(ctx: TenantContext, id: string): Promise<DashboardDetail> {
    return this.run(ctx, async (tx) => {
      const dashboard = await this.find(tx, id);
      return this.detail(tx, ctx, dashboard);
    });
  }

  async create(
    ctx: TenantContext,
    input: { name: string; description?: string | null; visibility: 'PRIVATE' | 'ORG' },
  ): Promise<DashboardDetail> {
    return this.run(ctx, async (tx) => {
      // Counts only visible dashboards: a limit per org would need a security-definer count.
      if (
        (await tx.dashboard.count({ where: { ownerId: ctx.userId } })) >= MAX_DASHBOARDS_PER_ORG
      ) {
        throw new ConflictError(`At most ${MAX_DASHBOARDS_PER_ORG} dashboards per user`);
      }
      const dashboard = await tx.dashboard.create({
        data: {
          id: uuidv7(),
          organizationId: ctx.organizationId,
          ownerId: ctx.userId,
          name: input.name,
          description: input.description ?? null,
          visibility: input.visibility,
        },
      });
      await this.record(tx, ctx, 'dashboard.created', dashboard.id, {
        name: dashboard.name,
        visibility: dashboard.visibility,
      });
      return this.detail(tx, ctx, dashboard);
    });
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: { name?: string; description?: string | null; visibility?: 'PRIVATE' | 'ORG' },
  ): Promise<DashboardDetail> {
    return this.run(ctx, async (tx) => {
      const dashboard = await this.editable(tx, ctx, id);
      if (input.visibility && input.visibility !== dashboard.visibility) {
        if (dashboard.ownerId !== ctx.userId) {
          throw new ForbiddenError('Only the owner of the dashboard can change who sees it');
        }
        await this.record(tx, ctx, 'dashboard.visibility_changed', id, {
          from: dashboard.visibility,
          to: input.visibility,
        });
      }
      const updated = await tx.dashboard.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        },
      });
      return this.detail(tx, ctx, updated);
    });
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    await this.run(ctx, async (tx) => {
      const dashboard = await this.editable(tx, ctx, id);
      await tx.dashboard.delete({ where: { id } });
      await this.record(tx, ctx, 'dashboard.deleted', id, { name: dashboard.name });
    });
  }

  // ─── Widgets ───────────────────────────────────────────────────────────────

  async addWidget(
    ctx: TenantContext,
    dashboardId: string,
    input: WidgetInput,
  ): Promise<DashboardDetail> {
    const source =
      'fromMessageId' in input ? await this.pinnedAnswer(ctx, input.fromMessageId) : null;
    const title = input.title ?? source?.title ?? '';
    const query = source?.query ?? (input as { query: SemanticQueryParsed }).query;
    const chart = source?.chart ?? (input as { chart: ChartSpec }).chart;
    // Validated as the author: a widget the author cannot run is not saved.
    const compiled = await this.engine.compile(ctx, query);

    return this.run(ctx, async (tx) => {
      const dashboard = await this.editable(tx, ctx, dashboardId);
      const widgets = await tx.dashboardWidget.findMany({ where: { dashboardId } });
      if (widgets.length >= MAX_WIDGETS_PER_DASHBOARD) {
        throw new ConflictError(`At most ${MAX_WIDGETS_PER_DASHBOARD} widgets per dashboard`);
      }
      await tx.dashboardWidget.create({
        data: {
          id: uuidv7(),
          organizationId: ctx.organizationId,
          dashboardId,
          title: title.slice(0, 120) || query.metrics.join(', '),
          semanticQuery: query,
          chartSpec: chart,
          position: input.position ?? nextPosition(widgets),
          sourceMessageId: source?.messageId ?? null,
          savedModelRevision: compiled.modelRevision,
          savedMetricVersions: compiled.metrics,
          createdBy: ctx.userId,
        },
      });
      return this.detail(tx, ctx, await touch(tx, dashboard.id));
    });
  }

  async updateWidget(
    ctx: TenantContext,
    widgetId: string,
    input: {
      title?: string;
      query?: SemanticQueryParsed;
      chart?: ChartSpec;
      position?: WidgetPosition;
    },
  ): Promise<DashboardDetail> {
    const compiled = input.query ? await this.engine.compile(ctx, input.query) : null;
    return this.run(ctx, async (tx) => {
      const widget = await this.findWidget(tx, widgetId);
      await this.editable(tx, ctx, widget.dashboardId);
      await tx.dashboardWidget.update({
        where: { id: widgetId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.chart ? { chartSpec: input.chart } : {}),
          ...(input.position ? { position: input.position } : {}),
          ...(input.query && compiled
            ? {
                semanticQuery: input.query,
                savedModelRevision: compiled.modelRevision,
                savedMetricVersions: compiled.metrics,
              }
            : {}),
        },
      });
      return this.detail(tx, ctx, await touch(tx, widget.dashboardId));
    });
  }

  async removeWidget(ctx: TenantContext, widgetId: string): Promise<DashboardDetail> {
    return this.run(ctx, async (tx) => {
      const widget = await this.findWidget(tx, widgetId);
      await this.editable(tx, ctx, widget.dashboardId);
      await tx.dashboardWidget.delete({ where: { id: widgetId } });
      return this.detail(tx, ctx, await touch(tx, widget.dashboardId));
    });
  }

  async updateLayout(
    ctx: TenantContext,
    dashboardId: string,
    widgets: { id: string; position: WidgetPosition }[],
  ): Promise<DashboardDetail> {
    return this.run(ctx, async (tx) => {
      await this.editable(tx, ctx, dashboardId);
      const existing = new Set(
        (await tx.dashboardWidget.findMany({ where: { dashboardId }, select: { id: true } })).map(
          (w) => w.id,
        ),
      );
      const unknown = widgets.find((w) => !existing.has(w.id));
      if (unknown) throw new NotFoundError('Widget not found on this dashboard');
      for (const w of widgets) {
        await tx.dashboardWidget.update({
          where: { id: w.id },
          data: { position: w.position },
        });
      }
      return this.detail(tx, ctx, await touch(tx, dashboardId));
    });
  }

  /** Runs a widget's query with the viewer's permissions and access policies. */
  async runWidget(ctx: TenantContext, widgetId: string): Promise<SemanticQueryResult> {
    const widget = await this.run(ctx, (tx) => this.findWidget(tx, widgetId));
    const query = semanticQuerySchema.parse(widget.semanticQuery);
    return this.engine.run(ctx, query, 'DASHBOARD');
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async find(tx: DbTransaction, id: string): Promise<Dashboard> {
    // RLS hides other users' PRIVATE dashboards: they are "not found", like other tenants' rows.
    const dashboard = await tx.dashboard.findUnique({ where: { id } });
    if (!dashboard) throw new NotFoundError('Dashboard not found');
    return dashboard;
  }

  private async findWidget(tx: DbTransaction, id: string): Promise<DashboardWidget> {
    const widget = await tx.dashboardWidget.findUnique({ where: { id } });
    if (!widget) throw new NotFoundError('Widget not found');
    return widget;
  }

  private async editable(tx: DbTransaction, ctx: TenantContext, id: string): Promise<Dashboard> {
    const dashboard = await this.find(tx, id);
    if (!canEdit(ctx, dashboard)) {
      throw new ForbiddenError('Only the owner or an organization admin can change this dashboard');
    }
    return dashboard;
  }

  /** The query and chart of an answer in one of the caller's own conversations. */
  private async pinnedAnswer(ctx: TenantContext, messageId: string) {
    return this.run(ctx, async (tx) => {
      const message = await tx.message.findUnique({
        where: { id: messageId },
        include: { conversation: { select: { userId: true } } },
      });
      if (!message || message.conversation.userId !== ctx.userId) {
        throw new NotFoundError('Message not found');
      }
      const answer = message.payload as Answer | null;
      const query =
        answer?.status === 'ANSWERED' ? semanticQuerySchema.safeParse(answer.query) : null;
      const chart = chartSpecSchema.safeParse(answer?.chart);
      if (!query?.success || !chart.success) {
        throw new ConflictError('Only answered questions with a query can be pinned');
      }
      return {
        messageId,
        query: query.data,
        chart: chart.data,
        title: answer?.provenance?.interpretedAs.split(' · ')[0] ?? null,
      };
    });
  }

  private async detail(
    tx: DbTransaction,
    ctx: TenantContext,
    dashboard: Dashboard,
  ): Promise<DashboardDetail> {
    const widgets = await tx.dashboardWidget.findMany({
      where: { dashboardId: dashboard.id },
      orderBy: { createdAt: 'asc' },
    });
    const owners = await ownerNames(tx, [dashboard]);
    return {
      ...toSummary(ctx, dashboard, widgets.length, owners),
      widgets: widgets.map(toWidgetDto),
    };
  }

  private record(
    tx: DbTransaction,
    ctx: TenantContext,
    action: string,
    dashboardId: string,
    changes: Prisma.InputJsonObject,
  ) {
    return this.audit.record(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'dashboard',
      resourceId: dashboardId,
      changes,
      meta: ctx,
    });
  }
}

const isOrgAdmin = (ctx: TenantContext) =>
  ctx.role === SystemRole.OWNER || ctx.role === SystemRole.ADMIN;

function canEdit(ctx: TenantContext, d: Dashboard): boolean {
  return d.ownerId === ctx.userId || (d.visibility === 'ORG' && isOrgAdmin(ctx));
}

const touch = (tx: DbTransaction, id: string) =>
  tx.dashboard.update({ where: { id }, data: { updatedAt: new Date() } });

/** Below the lowest widget, at the left edge. */
function nextPosition(widgets: DashboardWidget[]): WidgetPosition {
  const bottom = widgets.reduce((max, w) => {
    const p = widgetPositionSchema.safeParse(w.position);
    return p.success ? Math.max(max, p.data.y + p.data.h) : max;
  }, 0);
  return { x: 0, y: bottom, ...DEFAULT_SIZE };
}

async function ownerNames(tx: DbTransaction, dashboards: Dashboard[]) {
  const ids = [...new Set(dashboards.map((d) => d.ownerId))];
  if (ids.length === 0) return new Map<string, string>();
  // RLS shows users who share the current organization; former members stay unnamed.
  const users = await tx.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullName: true },
  });
  return new Map(users.map((u) => [u.id, u.fullName]));
}

function toSummary(
  ctx: TenantContext,
  d: Dashboard,
  widgetCount: number,
  owners: Map<string, string>,
): DashboardSummary {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    visibility: d.visibility,
    ownerId: d.ownerId,
    ownerName: owners.get(d.ownerId) ?? null,
    widgetCount,
    canEdit: canEdit(ctx, d),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

function toWidgetDto(w: DashboardWidget): DashboardWidgetDto {
  return {
    id: w.id,
    dashboardId: w.dashboardId,
    title: w.title,
    query: semanticQuerySchema.parse(w.semanticQuery),
    chart: chartSpecSchema.parse(w.chartSpec),
    position: widgetPositionSchema.parse(w.position),
    sourceMessageId: w.sourceMessageId,
    savedModelRevision: w.savedModelRevision,
    savedMetricVersions: w.savedMetricVersions as DashboardWidgetDto['savedMetricVersions'],
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}
