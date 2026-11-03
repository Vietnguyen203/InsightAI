import { Injectable } from '@nestjs/common';
import type {
  CleaningOperation,
  CleaningSuggestion,
  CleaningSuggestions,
  ColumnProfile,
  DateFormat,
  RuleDefinition,
} from '@insightai/contracts';
import { DataPlaneService } from '../../platform/data-plane/data-plane.service';
import { NotFoundError } from '../../platform/errors/app-error';
import type { TenantContext } from '../../platform/http/request-context';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { sqlString } from '../expression/expression';
import { type RuleSnapshot } from '../quality/quality-mappers';
import { qualifiedTable } from '../quality/version-columns';

const SUGGESTION_STATEMENT_TIMEOUT_MS = 30_000;
/** Variant detection groups values per column; only for columns with few distinct values. */
const MAX_DISTINCT_FOR_VARIANTS = 5_000;
const MAX_VARIANT_COLUMNS = 20;
const MAX_VARIANT_GROUPS = 50;
/** fill_null(median) is suggested only when few values are missing. */
const MAX_MISSING_SHARE_FOR_FILL = 0.2;
const WHITESPACE = `(' ' || chr(9) || chr(10) || chr(13) || chr(160))`;
const PHYSICAL_NAME = /^c_[0-9]{1,3}$/;

/** Date layouts detected among invalid raw values (same patterns as parse_date). */
const DATE_PATTERNS: { format: DateFormat; pattern: string; locale?: 'vi' | 'en' }[] = [
  { format: 'yyyy-MM-dd', pattern: '^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}$' },
  { format: 'dd/MM/yyyy', pattern: '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$', locale: 'vi' },
  { format: 'MM/dd/yyyy', pattern: '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$', locale: 'en' },
  { format: 'dd-MM-yyyy', pattern: '^[0-9]{1,2}-[0-9]{1,2}-[0-9]{4}$' },
  { format: 'dd.MM.yyyy', pattern: '^[0-9]{1,2}\\.[0-9]{1,2}\\.[0-9]{4}$' },
  { format: 'yyyy/MM/dd', pattern: '^[0-9]{4}/[0-9]{1,2}/[0-9]{1,2}$' },
  { format: 'yyyyMMdd', pattern: '^[0-9]{8}$' },
];

/** Row-level rule types whose failing rows can be removed with drop_rows { ruleId }. */
const ROW_RULES = new Set<RuleDefinition['type']>([
  'not_null',
  'regex',
  'allowed_values',
  'range',
  'length',
  'expression',
]);

/**
 * Rule-based cleaning suggestions (docs/DATA_QUALITY_DESIGN.md §6.2): deterministic, computed on
 * request from the latest quality results and a few aggregate queries. Nothing is applied.
 */
@Injectable()
export class CleaningSuggestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dataPlane: DataPlaneService,
  ) {}

  async suggest(
    ctx: TenantContext,
    datasetId: string,
    versionId: string | undefined,
  ): Promise<CleaningSuggestions> {
    const loaded = await this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const dataset = await tx.dataset.findUnique({ where: { id: datasetId } });
      if (!dataset) throw new NotFoundError('Dataset not found');
      const id = versionId ?? dataset.activeVersionId;
      if (!id) throw new NotFoundError('This dataset has no data yet');
      const version = await tx.datasetVersion.findFirst({
        where: { id, datasetId },
        include: { columns: { orderBy: { ordinal: 'asc' }, include: { profile: true } } },
      });
      if (!version) throw new NotFoundError('Version not found');
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: ctx.organizationId },
      });
      const check = await tx.qualityCheck.findFirst({
        where: { datasetVersionId: version.id, status: 'SUCCEEDED' },
        orderBy: { createdAt: 'desc' },
        include: { results: { where: { status: 'FAILED' } } },
      });
      return { version, organization, check };
    });
    const { version, organization, check } = loaded;
    for (const c of version.columns) {
      if (!PHYSICAL_NAME.test(c.physicalName)) throw new Error('Unexpected column identifier');
    }
    const typed = qualifiedTable(organization.dataSchema, version.physicalTable);
    const raw = version.rawTable ? qualifiedTable(organization.dataSchema, version.rawTable) : null;
    const byName = new Map(version.columns.map((c) => [c.name, c]));
    const failed = (check?.results ?? []).map((r) => ({
      ruleId: r.qualityRuleId,
      failed: Number(r.failedCount),
      evaluated: Number(r.evaluatedCount),
      snapshot: r.ruleSnapshot as unknown as RuleSnapshot,
    }));

    const text = version.columns.filter((c) => c.dataType === 'TEXT');
    const variantColumns = text
      .filter((c) => {
        const profile = c.profile?.stats as ColumnProfile | undefined;
        return profile !== undefined && profile.distinctCount <= MAX_DISTINCT_FOR_VARIANTS;
      })
      .slice(0, MAX_VARIANT_COLUMNS);
    const dateRepairs = raw
      ? failed.flatMap((f) => {
          const def = f.snapshot.definition;
          const c = def.type === 'type_castable' ? byName.get(def.column) : undefined;
          return c && c.dataType === 'DATE' ? [c] : [];
        })
      : [];
    const hasDuplicates = failed.some((f) => f.snapshot.definition.type === 'duplicate_rows');
    const locale = organization.locale === 'en' ? 'en' : 'vi';

    const scan = await this.dataPlane.withTenantRead(
      organization.dataSchema,
      async (client) => {
        const ref = (physical: string) => `t.${client.escapeIdentifier(physical)}`;
        // 1. One scan: whitespace per text column, duplicates, date layouts of invalid values.
        const parts = ['count(*) AS total'];
        const padded = text.map(
          (c) => `${ref(c.physicalName)} <> btrim(${ref(c.physicalName)}, ${WHITESPACE})`,
        );
        text.forEach((c, i) => parts.push(`count(*) FILTER (WHERE ${padded[i]}) AS w${i}`));
        if (padded.length > 0)
          parts.push(`count(*) FILTER (WHERE ${padded.join(' OR ')}) AS w_any`);
        const patterns = DATE_PATTERNS.filter((p) => !p.locale || p.locale === locale);
        dateRepairs.forEach((c, i) => {
          const original = `NULLIF(btrim(r.${client.escapeIdentifier(c.physicalName)}), '')`;
          patterns.forEach((p, k) => {
            parts.push(
              `count(*) FILTER (WHERE ${ref(c.physicalName)} IS NULL AND ${original} ~ ${sqlString(p.pattern)}) AS d${i}_${k}`,
            );
          });
        });
        if (hasDuplicates) {
          const all = version.columns.map((c) => ref(c.physicalName)).join(', ');
          parts.push(`count(*) - count(DISTINCT md5(row(${all})::text)) AS dup`);
        }
        const from =
          dateRepairs.length > 0 && raw
            ? `${typed} t LEFT JOIN ${raw} r ON r._row_id = t._row_id`
            : `${typed} t`;
        const counts = (
          await client.query<Record<string, string>>(`SELECT ${parts.join(', ')} FROM ${from}`)
        ).rows[0]!;

        // 2. Case/whitespace variants of the same value, per low-cardinality text column.
        const variants = new Map<string, { values: string[]; counts: number[] }[]>();
        for (const c of variantColumns) {
          const col = ref(c.physicalName);
          const groups = await client.query<{ vs: string[]; ns: string[] }>(
            `SELECT array_agg(v ORDER BY n DESC, v) AS vs, array_agg(n ORDER BY n DESC, v) AS ns FROM (` +
              `SELECT lower(btrim(${col}, ${WHITESPACE})) AS k, ${col} AS v, count(*) AS n FROM ${typed} t ` +
              `WHERE ${col} IS NOT NULL GROUP BY 1, 2) g GROUP BY k HAVING count(*) > 1 ` +
              `ORDER BY sum(n) DESC LIMIT ${MAX_VARIANT_GROUPS}`,
          );
          if (groups.rows.length > 0) {
            variants.set(
              c.name,
              groups.rows.map((g) => ({ values: g.vs, counts: g.ns.map(Number) })),
            );
          }
        }
        return { counts, patterns, variants };
      },
      { statementTimeoutMs: SUGGESTION_STATEMENT_TIMEOUT_MS },
    );

    const suggestions: CleaningSuggestion[] = [];
    const add = (
      id: string,
      operation: CleaningOperation,
      code: string,
      message: string,
      params: Record<string, string | number>,
      estimatedRows: number | null,
    ) =>
      suggestions.push({
        id,
        operation,
        source: 'RULE',
        rationale: { code, message, params },
        estimatedRows,
      });

    // Whitespace.
    const padded = text.filter((_, i) => Number(scan.counts[`w${i}`]) > 0);
    if (padded.length > 0) {
      add(
        'trim_whitespace',
        { type: 'trim_whitespace', columns: padded.map((c) => c.name), collapseInner: false },
        'TRIM_WHITESPACE',
        `Leading or trailing spaces in ${padded.map((c) => c.name).join(', ')}`,
        { columns: padded.map((c) => c.name).join(', ') },
        Number(scan.counts.w_any),
      );
    }

    // Spelling variants: map every variant (and its trimmed form) to the most frequent one.
    for (const [column, groups] of scan.variants) {
      const mapping: { from: string; to: string }[] = [];
      let rows = 0;
      for (const group of groups) {
        const target = group.values[0]!.trim();
        const seen = new Set<string>([target]);
        group.values.forEach((value, i) => {
          for (const from of [value, value.trim()]) {
            if (seen.has(from)) continue;
            seen.add(from);
            mapping.push({ from, to: target });
          }
          if (value !== target) rows += group.counts[i] ?? 0;
        });
      }
      if (mapping.length === 0) continue;
      add(
        `replace_values:${column}`,
        { type: 'replace_values', column, mapping: mapping.slice(0, 500), caseSensitive: true },
        'UNIFY_VARIANTS',
        `${groups.length} value(s) in ${column} are written in several ways`,
        { column, groups: groups.length },
        rows,
      );
    }

    // Dates written in another layout.
    dateRepairs.forEach((c, i) => {
      const current = (c.detectedFormat ?? '') as DateFormat;
      const found = scan.patterns
        .map((p, k) => ({ format: p.format, count: Number(scan.counts[`d${i}_${k}`]) }))
        .filter((p) => p.count > 0)
        .sort((a, b) => b.count - a.count);
      if (found.length === 0) return;
      const formats = [...new Set<DateFormat>([...found.map((f) => f.format)])];
      if (DATE_PATTERNS.some((p) => p.format === current) && !formats.includes(current)) {
        formats.unshift(current);
      }
      add(
        `parse_date:${c.name}`,
        { type: 'parse_date', column: c.name, formats },
        'PARSE_DATES',
        `Invalid dates in ${c.name} follow other layouts (${found.map((f) => f.format).join(', ')})`,
        { column: c.name, formats: found.map((f) => f.format).join(', ') },
        found.reduce((sum, f) => sum + f.count, 0),
      );
    });

    // Missing numbers.
    for (const f of failed) {
      const def = f.snapshot.definition;
      if (def.type !== 'not_null') continue;
      const c = byName.get(def.column);
      if (!c || (c.dataType !== 'INTEGER' && c.dataType !== 'DECIMAL')) continue;
      if (f.evaluated === 0 || f.failed / f.evaluated > MAX_MISSING_SHARE_FOR_FILL) continue;
      add(
        `fill_null:${c.name}`,
        { type: 'fill_null', column: c.name, strategy: 'median' },
        'FILL_MEDIAN',
        `${f.failed} missing value(s) in ${c.name} can be filled with the median`,
        { column: c.name, count: f.failed },
        f.failed,
      );
    }

    // Duplicates.
    if (hasDuplicates && Number(scan.counts.dup) > 0) {
      add(
        'deduplicate',
        { type: 'deduplicate', keyColumns: [], keep: 'first' },
        'REMOVE_DUPLICATE_ROWS',
        'Some rows are exact copies of earlier rows',
        { count: Number(scan.counts.dup) },
        Number(scan.counts.dup),
      );
    }
    for (const f of failed) {
      const def = f.snapshot.definition;
      if (def.type !== 'unique') continue;
      add(
        `deduplicate:${def.columns.join(',')}`,
        { type: 'deduplicate', keyColumns: def.columns, keep: 'first' },
        'REMOVE_DUPLICATE_KEYS',
        `Several rows share the same ${def.columns.join(', ')}; keep the first of each`,
        { columns: def.columns.join(', '), count: f.failed },
        null,
      );
    }

    // Rows failing error-severity rules (removing data is the user's call).
    for (const f of failed) {
      if (!f.ruleId || f.snapshot.severity !== 'error') continue;
      if (!ROW_RULES.has(f.snapshot.definition.type)) continue;
      add(
        `drop_rows:${f.ruleId}`,
        { type: 'drop_rows', ruleId: f.ruleId },
        'DROP_FAILING_ROWS',
        `Remove the ${f.failed} row(s) failing "${f.snapshot.name}"`,
        { rule: f.snapshot.name, count: f.failed },
        f.failed,
      );
    }

    return { versionId: version.id, qualityCheckId: check?.id ?? null, suggestions };
  }
}
