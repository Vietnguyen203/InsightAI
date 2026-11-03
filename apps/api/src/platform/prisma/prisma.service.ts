import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ValidationError } from '../errors/app-error';
import { APP_CONFIG, type AppConfig } from '../config/config.module';
import { type Prisma, PrismaClient } from '../../generated/prisma/client';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TenantTransaction = Prisma.TransactionClient;

/**
 * Metadata-plane client. Connects as the application role, which is subject to
 * PostgreSQL Row-Level Security on every tenant-scoped table (decision D-06).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });
  }

  /**
   * Runs `work` in a transaction where `app.org_id` is set for the current tenant.
   * RLS policies compare `organization_id` against this setting, so queries issued
   * through `tx` can only see and write rows of `organizationId`. `set_config(..., true)`
   * is transaction-local, so the setting never leaks to the next user of the pooled connection.
   */
  async runInTenant<T>(
    organizationId: string,
    work: (tx: TenantTransaction) => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (!UUID_PATTERN.test(organizationId)) {
      throw new ValidationError('organizationId must be a UUID');
    }
    return this.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.org_id', ${organizationId}, true)`;
        return work(tx);
      },
      { timeout: options?.timeoutMs ?? 10_000 },
    );
  }

  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
