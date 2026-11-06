import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  createInvestigationRequestSchema,
  type Evidence,
  evidenceSchema,
  type InvestigationDetail,
  investigationDetailSchema,
  type InvestigationReport,
  investigationReportSchema,
  type InvestigationSummary,
  investigationSummarySchema,
  Permission,
  TERMINAL_INVESTIGATION_STATUSES,
} from '@insightai/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.module';
import { RequirePermissions } from '../../platform/http/decorators';
import { CurrentTenant, type TenantContext } from '../../platform/http/request-context';
import { ApiZodBody, ApiZodResponse, zod } from '../../platform/http/zod';
import { InvestigationEventsService, type StoredEvent } from './investigation-events.service';
import { InvestigationService } from './investigation.service';

const MAX_STREAM_MS = 10 * 60_000;

@ApiTags('investigations')
@Controller('investigations')
export class InvestigationController {
  constructor(
    private readonly investigations: InvestigationService,
    private readonly events: InvestigationEventsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post()
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  @ApiZodBody(createInvestigationRequestSchema)
  @ApiZodResponse(202, investigationDetailSchema)
  @HttpCode(202)
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body(zod(createInvestigationRequestSchema))
    body: z.output<typeof createInvestigationRequestSchema>,
  ): Promise<InvestigationDetail> {
    return this.investigations.create(ctx, body);
  }

  @Get()
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  @ApiZodResponse(200, z.array(investigationSummarySchema))
  list(@CurrentTenant() ctx: TenantContext): Promise<InvestigationSummary[]> {
    return this.investigations.list(ctx);
  }

  @Get(':investigationId')
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  @ApiZodResponse(200, investigationDetailSchema)
  get(
    @CurrentTenant() ctx: TenantContext,
    @Param('investigationId', ParseUUIDPipe) id: string,
  ): Promise<InvestigationDetail> {
    return this.investigations.get(ctx, id);
  }

  /** Evidence frozen when each step ran (queries, versions, policies, result rows). */
  @Get(':investigationId/evidence')
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  @ApiZodResponse(200, z.array(evidenceSchema))
  evidence(
    @CurrentTenant() ctx: TenantContext,
    @Param('investigationId', ParseUUIDPipe) id: string,
  ): Promise<Evidence[]> {
    return this.investigations.evidence(ctx, id);
  }

  /** Rendered report: every figure is tied to its evidence; 409 until the run has ended. */
  @Get(':investigationId/report')
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  @ApiZodResponse(200, investigationReportSchema)
  report(
    @CurrentTenant() ctx: TenantContext,
    @Param('investigationId', ParseUUIDPipe) id: string,
  ): Promise<InvestigationReport> {
    return this.investigations.report(ctx, id);
  }

  @Post(':investigationId/approve')
  @HttpCode(200)
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  @ApiZodResponse(200, investigationDetailSchema)
  approve(
    @CurrentTenant() ctx: TenantContext,
    @Param('investigationId', ParseUUIDPipe) id: string,
  ): Promise<InvestigationDetail> {
    return this.investigations.approve(ctx, id);
  }

  @Post(':investigationId/cancel')
  @HttpCode(200)
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  @ApiZodResponse(200, investigationDetailSchema)
  cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('investigationId', ParseUUIDPipe) id: string,
  ): Promise<InvestigationDetail> {
    return this.investigations.cancel(ctx, id);
  }

  @Delete(':investigationId')
  @HttpCode(204)
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  remove(
    @CurrentTenant() ctx: TenantContext,
    @Param('investigationId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.investigations.remove(ctx, id);
  }

  /**
   * Progress as server-sent events (`id: <seq>`, `data: <InvestigationEvent>`). Replays what
   * happened after `Last-Event-ID`, then streams live until the investigation ends.
   */
  @Get(':investigationId/events')
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  @ApiProduces('text/event-stream')
  async stream(
    @CurrentTenant() ctx: TenantContext,
    @Param('investigationId', ParseUUIDPipe) id: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    await this.investigations.assertVisible(ctx, id);
    const db = { organizationId: ctx.organizationId, userId: ctx.userId };

    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();

    let last = /^\d{1,18}$/.test(lastEventId ?? '') ? BigInt(lastEventId!) : 0n;
    let ended = false;
    const subscriber = this.events.subscriber();
    const pending: StoredEvent[] = [];
    let replaying = true;
    const end = () => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      clearTimeout(limit);
      subscriber.disconnect();
      if (!res.writableEnded) res.end();
    };
    const write = (e: StoredEvent) => {
      if (ended || BigInt(e.seq) <= last) return;
      last = BigInt(e.seq);
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e.event)}\n\n`);
      if (e.event.type === 'done') end();
    };
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, this.config.AI_SSE_HEARTBEAT_MS);
    const limit = setTimeout(end, MAX_STREAM_MS); // clients reconnect with Last-Event-ID
    res.on('close', end);

    subscriber.on('message', (_channel: string, message: string) => {
      const e = JSON.parse(message) as StoredEvent;
      if (replaying) pending.push(e);
      else write(e);
    });
    subscriber.on('error', () => undefined);
    await subscriber.subscribe(InvestigationEventsService.channel(ctx.organizationId, id));

    for (const e of await this.events.replay(db, id, last)) write(e);
    replaying = false;
    for (const e of pending) write(e);

    // Ended before any listener could see "done" (e.g. an old investigation): close now.
    if (!ended) {
      const status = await this.investigations.assertVisible(ctx, id);
      if (TERMINAL_INVESTIGATION_STATUSES.includes(status)) {
        for (const e of await this.events.replay(db, id, last)) write(e);
        end();
      }
    }
  }
}
