import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type AuditLogEntry,
  auditLogEntrySchema,
  type Page,
  pageQuerySchema,
  pageSchema,
  Permission,
} from '@insightai/contracts';
import type { z } from 'zod';
import { RequirePermissions } from '../../platform/http/decorators';
import { CurrentTenant, type TenantContext } from '../../platform/http/request-context';
import { ApiZodQuery, ApiZodResponse, zod } from '../../platform/http/zod';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions(Permission.AUDIT_READ)
  @ApiZodQuery(pageQuerySchema)
  @ApiZodResponse(200, pageSchema(auditLogEntrySchema))
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query(zod(pageQuerySchema)) query: z.output<typeof pageQuerySchema>,
  ): Promise<Page<AuditLogEntry>> {
    return this.audit.list(ctx.organizationId, query);
  }
}
