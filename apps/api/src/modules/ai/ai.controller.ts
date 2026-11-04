import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
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
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequirePermissions } from '../../platform/http/decorators';
import { CurrentTenant, type TenantContext } from '../../platform/http/request-context';
import { ApiZodBody, ApiZodResponse, zod } from '../../platform/http/zod';
import { AiService } from './ai.service';

@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

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
    @Req() req: Request,
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
    // Stop calling the model when the client goes away.
    const abort = new AbortController();
    req.on('close', () => abort.abort());

    send({ type: 'conversation', conversationId: target.conversationId });
    await this.ai.ask(ctx, target, body.question, send, abort.signal);
    res.end();
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
