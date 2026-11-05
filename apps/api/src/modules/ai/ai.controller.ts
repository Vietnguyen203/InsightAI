import {
  Body,
  Controller,
  Inject,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  type AiStatus,
  aiStatusSchema,
  askRequestSchema,
  type AskEvent,
  type ConversationDetail,
  conversationDetailSchema,
  type ConversationSummary,
  conversationSummarySchema,
  Permission,
} from '@insightai/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.module';
import { RequirePermissions } from '../../platform/http/decorators';
import { CurrentTenant, type TenantContext } from '../../platform/http/request-context';
import { ApiZodBody, ApiZodResponse, zod } from '../../platform/http/zod';
import { AiService } from './ai.service';

@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('status')
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  @ApiZodResponse(200, aiStatusSchema)
  status(@CurrentTenant() ctx: TenantContext): Promise<AiStatus> {
    return this.ai.status(ctx);
  }

  /**
   * Asks a question; the answer streams as server-sent events (`data: <AskEvent JSON>`).
   * Problems found before streaming (AI not configured, quota, unknown model) are normal
   * RFC 7807 errors.
   */
  @Post('ask')
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  @ApiZodBody(askRequestSchema)
  @ApiProduces('text/event-stream')
  async ask(
    @CurrentTenant() ctx: TenantContext,
    @Body(zod(askRequestSchema)) body: z.output<typeof askRequestSchema>,
    @Res() res: Response,
  ): Promise<void> {
    const target = await this.ai.prepare(ctx, body);

    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();
    const send = (event: AskEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    // Stop calling the model when the client goes away or the answer takes too long.
    const abort = new AbortController();
    // `req` emits 'close' as soon as the body is read; the response closing early is what
    // tells that the client went away.
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    const signal = AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(this.config.AI_ANSWER_TIMEOUT_MS),
    ]);
    // Comment lines keep proxies and load balancers from closing an idle stream.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, this.config.AI_SSE_HEARTBEAT_MS);

    try {
      send({ type: 'conversation', conversationId: target.conversationId });
      await this.ai.ask(ctx, target, body.question, send, signal);
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }

  @Get('conversations')
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  @ApiZodResponse(200, z.array(conversationSummarySchema))
  list(@CurrentTenant() ctx: TenantContext): Promise<ConversationSummary[]> {
    return this.ai.list(ctx);
  }

  @Get('conversations/:conversationId')
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  @ApiZodResponse(200, conversationDetailSchema)
  get(
    @CurrentTenant() ctx: TenantContext,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ): Promise<ConversationDetail> {
    return this.ai.get(ctx, conversationId);
  }

  @Delete('conversations/:conversationId')
  @HttpCode(204)
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  remove(
    @CurrentTenant() ctx: TenantContext,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ): Promise<void> {
    return this.ai.remove(ctx, conversationId);
  }
}
