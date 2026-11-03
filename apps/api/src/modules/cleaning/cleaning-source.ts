import { type CleaningOperation, isValidTimeZone, type RuleDefinition } from '@insightai/contracts';
import { ValidationError } from '../../platform/errors/app-error';
import type { DbTransaction } from '../../platform/prisma/prisma.service';
import { snapshotOf } from '../quality/quality-mappers';
import { qualifiedTable } from '../quality/version-columns';
import { CleaningCompileError, type CompiledCleaning, compileCleaning } from './cleaning-compiler';

/**
 * Loads everything needed to compile operations against a version: its columns, data-plane
 * tables, the organization's locale/time zone and the quality rules referenced by drop_rows.
 * Shared by the API (validation, preview) and the worker (apply), so both compile identically.
 */
export async function loadCleaningSource(
  tx: DbTransaction,
  organizationId: string,
  versionId: string,
  operations: CleaningOperation[],
) {
  const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const version = await tx.datasetVersion.findUniqueOrThrow({
    where: { id: versionId },
    include: { columns: { orderBy: { ordinal: 'asc' } } },
  });

  const ruleIds = operations.flatMap((op) =>
    op.type === 'drop_rows' && op.ruleId ? [op.ruleId] : [],
  );
  const rules = new Map<string, RuleDefinition>();
  if (ruleIds.length > 0) {
    const found = await tx.qualityRule.findMany({
      where: { id: { in: ruleIds }, datasetId: version.datasetId },
    });
    for (const rule of found) rules.set(rule.id, snapshotOf(rule).definition);
  }

  return {
    organization,
    version,
    rules,
    sourceTable: qualifiedTable(organization.dataSchema, version.physicalTable),
    rawTable: version.rawTable ? qualifiedTable(organization.dataSchema, version.rawTable) : null,
  };
}

export type CleaningSource = Awaited<ReturnType<typeof loadCleaningSource>>;

/** Compiles, turning operation errors into a 400 that names the failing operation. */
export function compileFor(
  source: CleaningSource,
  operations: CleaningOperation[],
): CompiledCleaning {
  try {
    return compileCleaning({
      operations,
      columns: source.version.columns,
      sourceTable: source.sourceTable,
      rawTable: source.rawTable,
      locale: source.organization.locale === 'en' ? 'en' : 'vi',
      timezone: isValidTimeZone(source.organization.timezone)
        ? source.organization.timezone
        : 'UTC',
      rules: source.rules,
    });
  } catch (error) {
    if (error instanceof CleaningCompileError) {
      throw new ValidationError(`Operation ${error.index + 1}: ${error.message}`, [
        { path: `operations.${error.index}`, message: error.message },
      ]);
    }
    throw error;
  }
}

/** Safe, user-facing description of a database error raised while running operations. */
export function describeCleaningDbError(error: unknown): string {
  const code = (error as { code?: string }).code;
  if (code === '57014') return 'The operations took too long and were cancelled';
  if (code === '2201B') return 'Invalid regular expression';
  if (code === '22P02' || code === '22003' || code === '22007' || code === '22008')
    return 'A value could not be converted';
  return 'The operations could not be run on this data';
}

/** Postgres errors caused by the data/operations rather than the system. */
export function isDataError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return (
    typeof code === 'string' && (code.startsWith('22') || code === '2201B' || code === '42883')
  );
}
