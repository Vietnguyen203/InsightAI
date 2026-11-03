import { Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import { Prisma, type QualityRule } from '../../generated/prisma/client';
import { uuidv7 } from '../../platform/crypto/ids';
import { DataPlaneService } from '../../platform/data-plane/data-plane.service';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { type RuleSnapshot, snapshotOf } from './quality-mappers';
import { loadVersionContext, resolveForeignKey } from './quality-rule.service';
import {
  type CompiledRule,
  compileRule,
  computeScore,
  passRate,
  RuleDefinitionError,
  ruleStatus,
  type ScoredResult,
} from './rule-compiler';
import { qualifiedTable, RAW_ALIAS, TYPED_ALIAS } from './version-columns';

/** Generous per-statement limit: checks scan whole tables (millions of rows). */
const CHECK_STATEMENT_TIMEOUT_MS = 2 * 60_000;
export const MAX_SAMPLES_PER_RULE = 100;

interface Evaluated {
  rule: QualityRule;
  snapshot: RuleSnapshot;
  status: 'PASSED' | 'FAILED' | 'SKIPPED' | 'ERROR';
  evaluated: number;
  failed: number;
  message: string | null;
  samples: {
    rowId: number;
    column: string | null;
    value: string | null;
    rawValue: string | null;
  }[];
}

interface Sources {
  /** FROM clause of the typed table (alias t), with the raw table joined when a rule needs it. */
  from: (withRaw: boolean) => string;
}

export type CheckOutcome = 'succeeded' | 'failed' | 'skipped';

/**
 * Executes a quality check in the worker (docs/DATA_QUALITY_DESIGN.md §5). Row-level rules are
 * batched into one scan; if that batch fails (e.g. a pathological regex hits the timeout), rules
 * are re-run one by one so a single bad rule is reported as ERROR instead of failing the check.
 */
@Injectable()
export class QualityRunnerService {
  private readonly logger = new Logger(QualityRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dataPlane: DataPlaneService,
  ) {}

  async run(
    organizationId: string,
    checkId: string,
    isFinalAttempt: boolean,
  ): Promise<CheckOutcome> {
    const loaded = await this.prisma.runInTenant(organizationId, async (tx) => {
      const { count } = await tx.qualityCheck.updateMany({
        where: { id: checkId, status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'RUNNING', startedAt: new Date() },
      });
      if (count === 0) return null;
      const check = await tx.qualityCheck.findUniqueOrThrow({ where: { id: checkId } });
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
      });
      const { version, columns } = await loadVersionContext(tx, check.datasetVersionId);
      const rules = await tx.qualityRule.findMany({
        where: { datasetId: check.datasetId, enabled: true },
        orderBy: { createdAt: 'asc' },
      });
      // Resolve foreign-key targets up front (they live in metadata).
      const compiled = new Map<string, CompiledRule | Error>();
      for (const rule of rules) {
        try {
          const definition = snapshotOf(rule).definition;
          const fk = await resolveForeignKey(tx, organization.dataSchema, definition);
          compiled.set(rule.id, compileRule(definition, columns, fk));
        } catch (error) {
          compiled.set(rule.id, error instanceof Error ? error : new Error(String(error)));
        }
      }
      return { check, dataSchema: organization.dataSchema, version, rules, compiled };
    });
    if (!loaded) return 'skipped';
    const { check, dataSchema, version, rules, compiled } = loaded;

    try {
      const typed = qualifiedTable(dataSchema, version.physicalTable);
      const raw = version.rawTable ? qualifiedTable(dataSchema, version.rawTable) : null;
      const sources: Sources = {
        from: (withRaw) =>
          withRaw && raw
            ? `${typed} ${TYPED_ALIAS} LEFT JOIN ${raw} ${RAW_ALIAS} ON ${RAW_ALIAS}._row_id = ${TYPED_ALIAS}._row_id`
            : `${typed} ${TYPED_ALIAS}`,
      };

      const results = await this.dataPlane.withTenantRead(
        dataSchema,
        (client) => this.evaluate(client, sources, rules, compiled),
        { statementTimeoutMs: CHECK_STATEMENT_TIMEOUT_MS },
      );
      await this.persist(organizationId, check.id, version.id, results);
      return 'succeeded';
    } catch (error) {
      this.logger.error({ err: error, checkId }, 'Quality check attempt failed');
      if (!isFinalAttempt) throw error;
      await this.prisma.runInTenant(organizationId, (tx) =>
        tx.qualityCheck.update({
          where: { id: checkId },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            error: {
              code: 'INTERNAL_ERROR',
              message: 'The quality check failed because of a system error.',
            },
          },
        }),
      );
      return 'failed';
    }
  }

  private async evaluate(
    client: pg.PoolClient,
    sources: Sources,
    rules: QualityRule[],
    compiled: Map<string, CompiledRule | Error>,
  ): Promise<Evaluated[]> {
    const results: Evaluated[] = [];
    const rowRules: { rule: QualityRule; plan: Extract<CompiledRule, { kind: 'row' }> }[] = [];

    for (const rule of rules) {
      const plan = compiled.get(rule.id);
      if (plan instanceof Error) {
        results.push(
          this.result(
            rule,
            plan instanceof RuleDefinitionError ? 'SKIPPED' : 'ERROR',
            0,
            0,
            plan.message,
          ),
        );
      } else if (plan?.kind === 'row') {
        rowRules.push({ rule, plan });
      }
    }

    // 1. All row-level rules in one scan (fallback: one by one to isolate a failing rule).
    const counts = new Map<string, { evaluated: number; failed: number } | Error>();
    if (rowRules.length > 0) {
      try {
        await client.query('SAVEPOINT batch');
        const batch = await this.countRowRules(
          client,
          sources,
          rowRules.map((r) => r.plan),
        );
        rowRules.forEach((r, i) => counts.set(r.rule.id, batch[i]!));
        await client.query('RELEASE SAVEPOINT batch');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT batch');
        for (const r of rowRules) {
          try {
            await client.query('SAVEPOINT single');
            counts.set(r.rule.id, (await this.countRowRules(client, sources, [r.plan]))[0]!);
            await client.query('RELEASE SAVEPOINT single');
          } catch (error) {
            await client.query('ROLLBACK TO SAVEPOINT single');
            counts.set(r.rule.id, error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
    }

    for (const { rule, plan } of rowRules) {
      const count = counts.get(rule.id)!;
      if (count instanceof Error) {
        results.push(this.result(rule, 'ERROR', 0, 0, describeDbError(count)));
        continue;
      }
      const evaluated = this.result(rule, null, count.evaluated, count.failed, null);
      if (count.failed > 0) evaluated.samples = await this.rowSamples(client, sources, plan);
      results.push(evaluated);
    }

    // 2. Set-level rules, each with its own query.
    for (const rule of rules) {
      const plan = compiled.get(rule.id);
      if (!plan || plan instanceof Error || plan.kind === 'row') continue;
      try {
        await client.query('SAVEPOINT single');
        results.push(
          plan.kind === 'groups'
            ? await this.evaluateGroups(client, sources, rule, plan)
            : await this.evaluateForeignKey(client, sources, rule, plan),
        );
        await client.query('RELEASE SAVEPOINT single');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT single');
        results.push(this.result(rule, 'ERROR', 0, 0, describeDbError(error)));
      }
    }
    return results;
  }

  private async countRowRules(
    client: pg.PoolClient,
    sources: Sources,
    plans: Extract<CompiledRule, { kind: 'row' }>[],
  ): Promise<{ evaluated: number; failed: number }[]> {
    const parts = plans.flatMap((p, i) => [
      `count(*) FILTER (WHERE ${p.applies}) AS e${i}`,
      `count(*) FILTER (WHERE (${p.applies}) AND (${p.fails})) AS f${i}`,
    ]);
    const withRaw = plans.some((p) => p.needsRaw);
    const row = (
      await client.query<Record<string, string>>(
        `SELECT ${parts.join(', ')} FROM ${sources.from(withRaw)}`,
      )
    ).rows[0]!;
    return plans.map((_, i) => ({ evaluated: Number(row[`e${i}`]), failed: Number(row[`f${i}`]) }));
  }

  private async rowSamples(
    client: pg.PoolClient,
    sources: Sources,
    plan: Extract<CompiledRule, { kind: 'row' }>,
  ): Promise<Evaluated['samples']> {
    const column = plan.sampleColumn;
    const withRaw = plan.needsRaw || column?.rawSql !== null;
    const value = column ? `${column.typedSql}::text` : 'NULL';
    const rawValue = column?.rawSql && withRaw ? column.rawSql : 'NULL';
    const rows = await client.query<{
      row_id: string;
      value: string | null;
      raw_value: string | null;
    }>(
      `SELECT ${TYPED_ALIAS}._row_id AS row_id, ${value} AS value, ${rawValue} AS raw_value ` +
        `FROM ${sources.from(withRaw)} WHERE (${plan.applies}) AND (${plan.fails}) ` +
        `ORDER BY ${TYPED_ALIAS}._row_id LIMIT ${MAX_SAMPLES_PER_RULE}`,
    );
    return rows.rows.map((r) => ({
      rowId: Number(r.row_id),
      column: column?.name ?? null,
      value: r.value,
      rawValue: r.raw_value !== r.value ? r.raw_value : null,
    }));
  }

  /** Uniqueness: every row whose key occurs more than once counts as failed. */
  private async evaluateGroups(
    client: pg.PoolClient,
    sources: Sources,
    rule: QualityRule,
    plan: Extract<CompiledRule, { kind: 'groups' }>,
  ): Promise<Evaluated> {
    const keys = plan.keySql.join(', ');
    const isDuplicateRows = snapshotOf(rule).definition.type === 'duplicate_rows';
    // Unique keys ignore rows with a missing key part; full-row duplicates include NULLs.
    const where = isDuplicateRows
      ? 'true'
      : plan.keySql.map((k) => `${k} IS NOT NULL`).join(' AND ');
    const counts = (
      await client.query<{ evaluated: string; failed: string }>(
        `SELECT coalesce(sum(n), 0) AS evaluated, coalesce(sum(n) FILTER (WHERE n > 1), 0) AS failed ` +
          `FROM (SELECT count(*) AS n FROM ${sources.from(false)} WHERE ${where} GROUP BY ${keys}) g`,
      )
    ).rows[0]!;
    const evaluated = this.result(
      rule,
      null,
      Number(counts.evaluated),
      Number(counts.failed),
      null,
    );
    if (evaluated.failed > 0) {
      const label = isDuplicateRows
        ? `'#' || (min(${TYPED_ALIAS}._row_id) OVER (PARTITION BY ${keys}))::text`
        : `concat_ws(' | ', ${plan.sampleColumns.map((c) => `${c.typedSql}::text`).join(', ')})`;
      const rows = await client.query<{ row_id: string; value: string }>(
        `SELECT row_id, value FROM (` +
          `SELECT ${TYPED_ALIAS}._row_id AS row_id, ${label} AS value, count(*) OVER (PARTITION BY ${keys}) AS n ` +
          `FROM ${sources.from(false)} WHERE ${where}) d WHERE n > 1 ORDER BY row_id LIMIT ${MAX_SAMPLES_PER_RULE}`,
      );
      evaluated.samples = rows.rows.map((r) => ({
        rowId: Number(r.row_id),
        column: isDuplicateRows ? null : plan.sampleColumns.map((c) => c.name).join(', '),
        // For full-row duplicates the value names the first row of the duplicate group.
        value: r.value,
        rawValue: null,
      }));
    }
    return evaluated;
  }

  private async evaluateForeignKey(
    client: pg.PoolClient,
    sources: Sources,
    rule: QualityRule,
    plan: Extract<CompiledRule, { kind: 'foreign_key' }>,
  ): Promise<Evaluated> {
    const c = plan.column.typedSql;
    // Compared as text so that e.g. an integer key can reference a text key.
    const missing = `NOT EXISTS (SELECT 1 FROM ${plan.refTable} x WHERE ${plan.refColumnSql}::text = ${c}::text)`;
    const counts = (
      await client.query<{ evaluated: string; failed: string }>(
        `SELECT count(*) FILTER (WHERE ${c} IS NOT NULL) AS evaluated, ` +
          `count(*) FILTER (WHERE ${c} IS NOT NULL AND ${missing}) AS failed FROM ${sources.from(false)}`,
      )
    ).rows[0]!;
    const evaluated = this.result(
      rule,
      null,
      Number(counts.evaluated),
      Number(counts.failed),
      null,
    );
    if (evaluated.failed > 0) {
      const rows = await client.query<{ row_id: string; value: string }>(
        `SELECT ${TYPED_ALIAS}._row_id AS row_id, ${c}::text AS value FROM ${sources.from(false)} ` +
          `WHERE ${c} IS NOT NULL AND ${missing} ORDER BY ${TYPED_ALIAS}._row_id LIMIT ${MAX_SAMPLES_PER_RULE}`,
      );
      evaluated.samples = rows.rows.map((r) => ({
        rowId: Number(r.row_id),
        column: plan.column.name,
        value: r.value,
        rawValue: null,
      }));
    }
    return evaluated;
  }

  private result(
    rule: QualityRule,
    status: Evaluated['status'] | null,
    evaluated: number,
    failed: number,
    message: string | null,
  ): Evaluated {
    return {
      rule,
      snapshot: snapshotOf(rule),
      status: status ?? ruleStatus(evaluated, failed, Number(rule.threshold)),
      evaluated,
      failed,
      message,
      samples: [],
    };
  }

  private async persist(
    organizationId: string,
    checkId: string,
    versionId: string,
    results: Evaluated[],
  ) {
    const scored: ScoredResult[] = results.map((r) => ({
      dimension: r.snapshot.dimension,
      severity: r.snapshot.severity,
      weight: r.snapshot.weight,
      threshold: r.snapshot.threshold,
      status: r.status,
      evaluated: r.evaluated,
      failed: r.failed,
    }));
    const summary = computeScore(scored);

    await this.prisma.runInTenant(
      organizationId,
      async (tx) => {
        for (const r of results) {
          const resultId = uuidv7();
          await tx.qualityCheckResult.create({
            data: {
              id: resultId,
              organizationId,
              qualityCheckId: checkId,
              qualityRuleId: r.rule.id,
              ruleSnapshot: r.snapshot as unknown as Prisma.InputJsonValue,
              status: r.status,
              evaluatedCount: BigInt(r.evaluated),
              failedCount: BigInt(r.failed),
              passRate:
                r.status === 'PASSED' || r.status === 'FAILED'
                  ? new Prisma.Decimal(passRate(r.evaluated, r.failed).toFixed(6))
                  : null,
              message: r.message,
              sampleCount: r.samples.length,
            },
          });
          if (r.samples.length > 0) {
            await tx.qualityIssue.createMany({
              data: r.samples.map((s) => ({
                organizationId,
                qualityCheckResultId: resultId,
                rowId: BigInt(s.rowId),
                columnName: s.column,
                value: s.value,
                rawValue: s.rawValue,
              })),
            });
          }
        }
        await tx.qualityCheck.update({
          where: { id: checkId },
          data: {
            status: 'SUCCEEDED',
            finishedAt: new Date(),
            score: summary.score === null ? null : new Prisma.Decimal(summary.score),
            qualityStatus: summary.qualityStatus,
            dimensionScores: summary.dimensionScores,
            rulesTotal: results.length,
            rulesFailed: summary.rulesFailed,
          },
        });
        await tx.datasetVersion.update({
          where: { id: versionId },
          data: {
            qualityStatus: summary.qualityStatus,
            qualityScore: summary.score === null ? null : new Prisma.Decimal(summary.score),
          },
        });
      },
      { timeoutMs: 60_000 },
    );
  }
}

/** Safe, user-facing description of a database error (no SQL or internals). */
function describeDbError(error: unknown): string {
  const code = (error as { code?: string }).code;
  if (code === '57014') return 'The rule took too long and was cancelled';
  if (code === '2201B') return 'Invalid regular expression';
  if (code === '22P02' || code === '22003')
    return 'A value could not be compared with the rule bounds';
  return 'The rule could not be evaluated';
}
