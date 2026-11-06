import { Inject, Injectable, Logger } from '@nestjs/common';
import type { InvestigationEvent } from '@insightai/contracts';
import type { Redis } from 'ioredis';
import { type DbContext, PrismaService } from '../../platform/prisma/prisma.service';
import { REDIS_CLIENT } from '../../platform/queue/queue.module';

export interface StoredEvent {
  seq: string;
  event: InvestigationEvent;
}

/**
 * Progress log of an investigation: written to PostgreSQL (replayable with Last-Event-ID) and
 * published on Redis so connected SSE clients get it immediately. Events never carry data
 * values – clients read details through the API with their own permissions.
 */
@Injectable()
export class InvestigationEventsService {
  private readonly logger = new Logger(InvestigationEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  static channel(organizationId: string, investigationId: string): string {
    return `investigation:${organizationId}:${investigationId}`;
  }

  async emit(
    db: Required<Pick<DbContext, 'organizationId' | 'userId'>>,
    investigationId: string,
    event: InvestigationEvent,
  ): Promise<void> {
    const row = await this.prisma.runInContext(db, (tx) =>
      tx.investigationEvent.create({
        data: {
          organizationId: db.organizationId,
          investigationId,
          type: event.type,
          data: event,
        },
        select: { seq: true },
      }),
    );
    const message: StoredEvent = { seq: row.seq.toString(), event };
    await this.redis
      .publish(
        InvestigationEventsService.channel(db.organizationId, investigationId),
        JSON.stringify(message),
      )
      .catch((error: unknown) => this.logger.warn({ err: error }, 'Could not publish event'));
  }

  async replay(
    db: Required<Pick<DbContext, 'organizationId' | 'userId'>>,
    investigationId: string,
    afterSeq: bigint,
  ): Promise<StoredEvent[]> {
    const rows = await this.prisma.runInContext(db, (tx) =>
      tx.investigationEvent.findMany({
        where: { investigationId, seq: { gt: afterSeq } },
        orderBy: { seq: 'asc' },
        take: 1000,
      }),
    );
    return rows.map((r) => ({ seq: r.seq.toString(), event: r.data as InvestigationEvent }));
  }

  /** A dedicated connection for SUBSCRIBE (a subscribed client cannot run other commands). */
  subscriber(): Redis {
    return this.redis.duplicate();
  }
}
