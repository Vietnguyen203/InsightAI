import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ValidationError } from '../errors/app-error';
import { APP_CONFIG, type AppConfig } from '../config/config.module';
import { UUID_PATTERN } from '../crypto/ids';
import { Prisma, PrismaClient } from '../../generated/prisma/client';

export type DbTransaction = Prisma.TransactionClient;

/**
 * Values exposed to Row-Level Security policies for one transaction (see migration
 * `*_iam_audit`). Every key is optional; an unset key matches nothing, so policies fail closed.
 */
export interface DbContext {
  organizationId?: string;
  userId?: string;
  /** Pre-authentication lookups: each one makes exactly one row visible. */
  loginEmail?: string;
  refreshTokenHash?: string;
  inviteTokenHash?: string;
}

const SETTINGS: Record<keyof DbContext, string> = {
  organizationId: 'app.org_id',
  userId: 'app.user_id',
  loginEmail: 'app.login_email',
  refreshTokenHash: 'app.refresh_token_hash',
  inviteTokenHash: 'app.invite_token_hash',
};

/**
 * Metadata-plane client. Connects as the application role, which is subject to
 * PostgreSQL Row-Level Security on every table that holds tenant or user data (decision D-06).
 * All application queries go through `runInContext`.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });
  }

  /**
   * Runs `work` in a transaction with the given context. `set_config(..., true)` is
   * transaction-local, so values never leak to the next user of the pooled connection.
   */
  async runInContext<T>(
    context: DbContext,
    work: (tx: DbTransaction) => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    for (const key of ['organizationId', 'userId'] as const) {
      const value = context[key];
      if (value !== undefined && !UUID_PATTERN.test(value)) {
        throw new ValidationError(`${key} must be a UUID`);
      }
    }
    const assignments = (Object.keys(SETTINGS) as (keyof DbContext)[])
      .filter((key) => context[key] !== undefined)
      .map((key) => Prisma.sql`set_config(${SETTINGS[key]}, ${context[key]}, true)`);

    return this.$transaction(
      async (tx) => {
        if (assignments.length > 0) {
          await tx.$queryRaw`SELECT ${Prisma.join(assignments)}`;
        }
        return work(tx);
      },
      { timeout: options?.timeoutMs ?? 10_000 },
    );
  }

  /** Shorthand for organization-scoped work. */
  runInTenant<T>(
    organizationId: string,
    work: (tx: DbTransaction) => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    return this.runInContext({ organizationId }, work, options);
  }

  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
