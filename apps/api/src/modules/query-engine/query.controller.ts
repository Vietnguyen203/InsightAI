import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type CompiledQuery,
  compiledQuerySchema,
  Permission,
  semanticQueryResultSchema,
  semanticQuerySchema,
  type SemanticQueryResult,
} from '@insightai/contracts';
import type { z } from 'zod';
import { RequirePermissions } from '../../platform/http/decorators';
import { CurrentTenant, type TenantContext } from '../../platform/http/request-context';
import { ApiZodBody, ApiZodResponse, zod } from '../../platform/http/zod';
import { QueryEngineService } from './query-engine.service';

@ApiTags('semantic-query')
@Controller('semantic-query')
export class QueryController {
  constructor(private readonly engine: QueryEngineService) {}

  /** Runs Semantic Query IR against the published model (422 QUERY_REJECTED with a reason). */
  @Post()
  @HttpCode(200)
  @RequirePermissions(Permission.SEMANTIC_QUERY)
  @ApiZodBody(semanticQuerySchema)
  @ApiZodResponse(200, semanticQueryResultSchema)
  run(
    @CurrentTenant() ctx: TenantContext,
    @Body(zod(semanticQuerySchema)) body: z.output<typeof semanticQuerySchema>,
  ): Promise<SemanticQueryResult> {
    return this.engine.run(ctx, body);
  }

  /** Shows the SQL a query compiles to, without running it (model editor). */
  @Post('compile')
  @HttpCode(200)
  @RequirePermissions(Permission.SEMANTIC_WRITE)
  @ApiZodBody(semanticQuerySchema)
  @ApiZodResponse(200, compiledQuerySchema)
  compile(
    @CurrentTenant() ctx: TenantContext,
    @Body(zod(semanticQuerySchema)) body: z.output<typeof semanticQuerySchema>,
  ): Promise<CompiledQuery> {
    return this.engine.compile(ctx, body);
  }
}
