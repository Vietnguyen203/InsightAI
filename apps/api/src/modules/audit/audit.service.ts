import { Injectable } from '@nestjs/common';
import type { AuditLogEntry, Page } from '@insightai/contracts';
import { Prisma } from '../../generated/prisma/client';
import type { RequestMeta } from '../../platform/http/request-context';
import { type DbTransaction, PrismaService } from '../../platform/prisma/prisma.service';

export interface AuditEvent {
  /** Omit for user-level events outside an organization (login, logout). */
  organizationId?: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string;
  /** Before/after values or other context. Never put secrets or tokens here. */
  changes?: Prisma.InputJsonValue;
  meta: RequestMeta;
}

/**
 * Append-only audit trail. `record` takes the caller's transaction so the audit row commits
 * or rolls back together with the change it describes. The application role cannot UPDATE or
 * DELETE audit rows (migration `*_iam_audit`).
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(tx: DbTransaction, event: AuditEvent): Promise<void> {
    // createMany issues a plain INSERT. `create` would add RETURNING, which PostgreSQL checks
    // against the SELECT policy, and user-level events (no organization) are not readable.
    await tx.auditLog.createMany({
      data: {
        organizationId: event.organizationId ?? null,
        actorUserId: event.actorUserId,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId ?? null,
        changes: event.changes ?? Prisma.DbNull,
        ip: event.meta.ip ?? null,
        userAgent: event.meta.userAgent ?? null,
        requestId: event.meta.requestId ?? null,
      },
    });
  }

  async list(
    organizationId: string,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<Page<AuditLogEntry>> {
    const cursor =
      query.cursor !== undefined && /^\d+$/.test(query.cursor) ? BigInt(query.cursor) : undefined;

    return this.prisma.runInTenant(organizationId, async (tx) => {
      const rows = await tx.auditLog.findMany({
        where: cursor !== undefined ? { id: { lt: cursor } } : {},
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);

      const actorIds = [...new Set(page.map((row) => row.actorUserId).filter((id) => id !== null))];
      // Only current members are visible through RLS; former members appear as `actor: null`.
      const actors = await tx.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, email: true, fullName: true },
      });
      const actorById = new Map(actors.map((actor) => [actor.id, actor]));

      return {
        items: page.map((row) => ({
          id: row.id.toString(),
          actor: row.actorUserId ? (actorById.get(row.actorUserId) ?? null) : null,
          action: row.action,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          changes: row.changes ?? null,
          ip: row.ip,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id.toString() ?? null) : null,
      };
    });
  }
}
