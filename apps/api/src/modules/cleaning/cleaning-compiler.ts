import type {
  CleaningOperation,
  ColumnDataType,
  DateFormat,
  RuleDefinition,
} from '@insightai/contracts';
import { compileExpression, ExpressionError, sqlString } from '../expression/expression';
import {
  candidatesFor,
  type ColumnType,
  type NumberLocale,
  SQL_TYPE,
} from '../import/type-inference';
import {
  compileRule,
  RuleDefinitionError,
  VALUE_TYPE,
  type VersionColumn,
} from '../quality/rule-compiler';

/**
 * Compiles an ordered list of cleaning operations into ONE SQL query over the source version
 * (docs/DATA_QUALITY_DESIGN.md §6.1). Pure: identifiers come from metadata (validated here),
 * every user value is escaped with sqlString or checked against a strict pattern.
 *
 * Shape: a chain of CTEs s0 → s1 → … → sN. s0 reads the source (and, when needed, the raw text
 * table). Every stage carries all columns plus
 *   _del  – index of the operation that removed the row (NULL = kept); rows are never filtered
 *           inside the chain so every operation can be counted on the whole table;
 *   _a<i> – true when operation i changed a value of the row.
 * Value-changing operations take two stages: new values are computed into temporary columns,
 * then swapped in while the flag compares old and new. The final table is
 *   SELECT _row_id, <columns> FROM sN WHERE _del IS NULL
 */

export class CleaningCompileError extends Error {
  constructor(
    readonly index: number,
    message: string,
  ) {
    super(message);
    this.name = 'CleaningCompileError';
  }
}

export interface SourceColumn {
  ordinal: number;
  name: string;
  originalName: string;
  physicalName: string;
  dataType: ColumnDataType;
}

export interface CompileInput {
  operations: CleaningOperation[];
  columns: SourceColumn[];
  /** Quoted, schema-qualified source (typed) table. */
  sourceTable: string;
  /** Quoted, schema-qualified raw text table, when the version has one. */
  rawTable: string | null;
  locale: NumberLocale;
  /** IANA time zone (already validated) for ISO timestamps with an offset. */
  timezone: string;
  /** Row-level rule definitions referenced by drop_rows { ruleId }. */
  rules: ReadonlyMap<string, RuleDefinition>;
}

export interface OutputColumn {
  ordinal: number;
  originalName: string;
  name: string;
  physicalName: string;
  dataType: ColumnDataType;
  source: SourceColumn;
  /** A value-changing operation touched the column. */
  modified: boolean;
  removed: boolean;
}

export interface CompiledCleaning {
  /** `WITH s0 AS (…), …, sN AS (…)` – shared by preview, impact and apply. */
  withClause: string;
  finalStage: string;
  /** Columns of the result in source order, including removed ones (removed = true). */
  columns: OutputColumn[];
  /** Per operation: the flag column counting changed rows (null for schema-only operations). */
  operations: { index: number; type: CleaningOperation['type']; flag: string | null }[];
}

const PHYSICAL_NAME = /^c_[0-9]{1,3}$/;
const QUALIFIED_TABLE = /^"t_[a-z0-9]{8,12}"\."[rv]_[a-z0-9]{10}_[a-z0-9]{8}"$/;
const INTEGER = /^[+-]?[0-9]{1,18}$/;
const NUMBER = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

/** Space, tab, LF, CR and no-break space (common in spreadsheets). */
const WHITESPACE = `(' ' || chr(9) || chr(10) || chr(13) || chr(160))`;

const DATE_FORMAT_SQL: Record<DateFormat, { pattern: string; format: string }> = {
  'yyyy-MM-dd': { pattern: '^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}$', format: 'YYYY-MM-DD' },
  'dd/MM/yyyy': { pattern: '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$', format: 'DD/MM/YYYY' },
  'MM/dd/yyyy': { pattern: '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$', format: 'MM/DD/YYYY' },
  'dd-MM-yyyy': { pattern: '^[0-9]{1,2}-[0-9]{1,2}-[0-9]{4}$', format: 'DD-MM-YYYY' },
  'dd.MM.yyyy': { pattern: '^[0-9]{1,2}\\.[0-9]{1,2}\\.[0-9]{4}$', format: 'DD.MM.YYYY' },
  'yyyy/MM/dd': { pattern: '^[0-9]{4}/[0-9]{1,2}/[0-9]{1,2}$', format: 'YYYY/MM/DD' },
  yyyyMMdd: { pattern: '^[0-9]{8}$', format: 'YYYYMMDD' },
};

interface ColumnState {
  source: SourceColumn;
  name: string;
  dataType: ColumnDataType;
  modified: boolean;
  removed: boolean;
}

interface Stage {
  /** Replacement expressions for carried columns (keyed by identifier). */
  overrides: Map<string, string>;
  /** New carried columns (flags). */
  adds: Map<string, string>;
  /** Columns visible to the next stage only. */
  temps: Map<string, string>;
}

const q = (identifier: string) => `"${identifier}"`;
const rawRef = (physical: string) => q(`_r_${physical}`);

export function compileCleaning(input: CompileInput): CompiledCleaning {
  if (!QUALIFIED_TABLE.test(input.sourceTable)) throw new Error('Unexpected source table');
  if (input.rawTable !== null && !QUALIFIED_TABLE.test(input.rawTable))
    throw new Error('Unexpected raw table');
  for (const c of input.columns) {
    if (!PHYSICAL_NAME.test(c.physicalName)) throw new Error('Unexpected column identifier');
  }

  const state: ColumnState[] = input.columns.map((source) => ({
    source,
    name: source.name,
    dataType: source.dataType,
    modified: false,
    removed: false,
  }));
  const stages: Stage[] = [];
  const flags: string[] = [];
  const operations: CompiledCleaning['operations'] = [];
  let needsRaw = false;

  /** Name of the stage the next pushed stage reads from. */
  const input_ = () => `s${stages.length}`;
  const push = (stage: Partial<Stage>) =>
    stages.push({
      overrides: stage.overrides ?? new Map<string, string>(),
      adds: stage.adds ?? new Map<string, string>(),
      temps: stage.temps ?? new Map<string, string>(),
    });

  input.operations.forEach((op, index) => {
    const fail = (message: string): never => {
      throw new CleaningCompileError(index, message);
    };
    const column = (name: string): ColumnState => {
      const found = state.find((c) => !c.removed && c.name === name);
      return found ?? fail(`Column "${name}" does not exist at this step`);
    };
    const textColumn = (name: string): ColumnState => {
      const c = column(name);
      if (c.dataType !== 'TEXT')
        fail(`"${name}" is ${c.dataType}; this operation needs a text column`);
      return c;
    };
    const ref = (c: ColumnState) => q(c.source.physicalName);

    /** Two stages: compute new values, then swap them in and flag changed rows. */
    const changeValues = (values: { column: ColumnState; sql: string; type: ColumnDataType }[]) => {
      const temps = new Map<string, string>();
      values.forEach((v, k) => temps.set(`_n${index}_${k}`, v.sql));
      push({ temps });
      const overrides = new Map<string, string>();
      const changed: string[] = [];
      values.forEach((v, k) => {
        const temp = q(`_n${index}_${k}`);
        const typed =
          v.type === 'TEXT' ? `NULLIF((${temp})::text, '')` : `(${temp})::${SQL_TYPE[v.type]}`;
        // Removed rows are recomputed too (harmless: they never reach the result or a count).
        overrides.set(v.column.source.physicalName, typed);
        changed.push(`(${typed})::text IS DISTINCT FROM ${ref(v.column)}::text`);
        v.column.modified = true;
        v.column.dataType = v.type;
      });
      const flag = `_a${index}`;
      push({
        overrides,
        adds: new Map([[flag, `(_del IS NULL AND (${changed.join(' OR ')}))`]]),
      });
      flags.push(flag);
      operations.push({ index, type: op.type, flag });
    };

    /** Marks rows removed by this operation. */
    const removeWhere = (predicate: string, extra?: Partial<Stage>) => {
      if (extra) push(extra);
      push({
        overrides: new Map([
          ['_del', `CASE WHEN _del IS NULL AND (${predicate}) THEN ${index} ELSE _del END`],
        ]),
      });
      operations.push({ index, type: op.type, flag: null });
    };

    /** Text to re-parse: the original file value for typed columns, the value itself for text. */
    const sourceText = (c: ColumnState): { primary: string; fallback: string | null } => {
      if (c.dataType === 'TEXT') return { primary: ref(c), fallback: null };
      if (input.rawTable) {
        needsRaw = true;
        return { primary: rawRef(c.source.physicalName), fallback: `${ref(c)}::text` };
      }
      return { primary: `${ref(c)}::text`, fallback: null };
    };

    switch (op.type) {
      case 'trim_whitespace': {
        const columns = unique(op.columns, index).map(textColumn);
        changeValues(
          columns.map((c) => {
            const value = op.collapseInner
              ? `regexp_replace(${ref(c)}, '[[:space:]]+', ' ', 'g')`
              : ref(c);
            return { column: c, sql: `btrim(${value}, ${WHITESPACE})`, type: 'TEXT' };
          }),
        );
        break;
      }
      case 'change_case': {
        const fn = { lower: 'lower', upper: 'upper', title: 'initcap' }[op.mode];
        changeValues(
          unique(op.columns, index)
            .map(textColumn)
            .map((c) => ({ column: c, sql: `${fn}(${ref(c)})`, type: 'TEXT' })),
        );
        break;
      }
      case 'replace_values': {
        const c = textColumn(op.column);
        const seen = new Set<string>();
        for (const m of op.mapping) {
          const key = op.caseSensitive ? m.from : m.from.toLowerCase();
          if (seen.has(key)) fail(`"${m.from}" appears more than once in the mapping`);
          seen.add(key);
        }
        const subject = op.caseSensitive ? ref(c) : `lower(${ref(c)})`;
        const whens = op.mapping
          .map((m) => {
            const from = sqlString(op.caseSensitive ? m.from : m.from.toLowerCase());
            return `WHEN ${from} THEN ${m.to === null ? 'NULL' : sqlString(m.to)}`;
          })
          .join(' ');
        changeValues([
          { column: c, sql: `CASE ${subject} ${whens} ELSE ${ref(c)} END`, type: 'TEXT' },
        ]);
        break;
      }
      case 'fill_null': {
        const c = column(op.column);
        const missing =
          c.dataType === 'TEXT'
            ? `(${ref(c)} IS NULL OR btrim(${ref(c)}, ${WHITESPACE}) = '')`
            : `${ref(c)} IS NULL`;
        const numeric = c.dataType === 'INTEGER' || c.dataType === 'DECIMAL';
        const prev = input_();
        let fill: string;
        switch (op.strategy) {
          case 'constant':
            fill = typedLiteral(c.dataType, op.value ?? '', fail);
            break;
          case 'mean':
          case 'median': {
            if (!numeric)
              fail(`${op.strategy} needs a number column, "${c.name}" is ${c.dataType}`);
            const value =
              op.strategy === 'mean'
                ? `avg(${ref(c)})`
                : // Exact median: average of the lower and upper middle values (no float conversion).
                  `(percentile_disc(0.5) WITHIN GROUP (ORDER BY ${ref(c)}) + percentile_disc(0.5) WITHIN GROUP (ORDER BY ${ref(c)} DESC)) / 2`;
            const scalar = `(SELECT ${value} FROM ${prev} WHERE _del IS NULL)`;
            fill =
              c.dataType === 'INTEGER'
                ? `round(${scalar})::bigint`
                : `trim_scale(round(${scalar}, 6))`;
            break;
          }
          case 'mode':
            fill =
              `(SELECT ${ref(c)} FROM ${prev} WHERE _del IS NULL AND NOT ${missing} ` +
              `GROUP BY ${ref(c)} ORDER BY count(*) DESC, ${ref(c)} LIMIT 1)`;
            break;
          case 'previous': {
            // Group each kept, non-missing value with the missing rows that follow it.
            const group = `_g${index}`;
            push({
              temps: new Map([
                [
                  group,
                  `count(CASE WHEN _del IS NULL AND NOT ${missing} THEN 1 END) OVER (ORDER BY _row_id)`,
                ],
              ]),
            });
            const agg = c.dataType === 'BOOLEAN' ? 'bool_or' : 'max';
            fill = `${agg}(CASE WHEN _del IS NULL AND NOT ${missing} THEN ${ref(c)} END) OVER (PARTITION BY ${q(group)})`;
            break;
          }
        }
        changeValues([
          {
            column: c,
            sql: `CASE WHEN ${missing} THEN ${fill} ELSE ${ref(c)} END`,
            type: c.dataType,
          },
        ]);
        break;
      }
      case 'cast_column': {
        const c = column(op.column);
        const text = sourceText(c);
        const parse = (value: string, locale: NumberLocale) =>
          parseAs(op.targetType, value, locale, input.timezone);
        // Values typed in the file are re-read with the requested layout; values filled by an
        // earlier operation (no file value) are read in canonical form.
        const sql = text.fallback
          ? `CASE WHEN NULLIF(btrim(${text.primary}), '') IS NOT NULL THEN ${parse(text.primary, op.locale ?? input.locale)} ELSE ${parse(text.fallback, 'en')} END`
          : parse(text.primary, op.locale ?? input.locale);
        changeValues([{ column: c, sql, type: op.targetType }]);
        break;
      }
      case 'parse_date': {
        const c = column(op.column);
        if (!['TEXT', 'DATE', 'TIMESTAMP'].includes(c.dataType)) {
          fail(`"${c.name}" is ${c.dataType}; parse_date needs a text or date column`);
        }
        const text = sourceText(c);
        const trimmed = `NULLIF(btrim(${text.primary}), '')`;
        const attempts = unique(op.formats, index).map((f) => {
          const { pattern, format } = DATE_FORMAT_SQL[f];
          return `CASE WHEN ${trimmed} ~ ${sqlString(pattern)} THEN dp.try_date(${trimmed}, ${sqlString(format)}) END`;
        });
        // Existing valid dates are kept; only missing/invalid values are parsed again.
        const keep = c.dataType === 'TEXT' ? [] : [`${ref(c)}::date`];
        changeValues([
          { column: c, sql: `coalesce(${[...keep, ...attempts].join(', ')})`, type: 'DATE' },
        ]);
        break;
      }
      case 'drop_rows': {
        if (op.condition !== undefined) {
          try {
            const compiled = compileExpression(
              op.condition,
              (name) => {
                const c = state.find((s) => !s.removed && s.name === name);
                return c ? { type: VALUE_TYPE[c.dataType], sql: ref(c) } : undefined;
              },
              'boolean',
            );
            // NULL ("unknown") keeps the row.
            removeWhere(`coalesce(${compiled.sql}, false)`);
          } catch (error) {
            if (error instanceof ExpressionError) fail(error.message);
            throw error;
          }
          break;
        }
        const definition =
          input.rules.get(op.ruleId ?? '') ?? fail('The quality rule does not exist');
        const columns = new Map<string, VersionColumn>(
          state
            .filter((s) => !s.removed)
            .map((s) => [
              s.name,
              {
                name: s.name,
                dataType: s.dataType,
                typedSql: ref(s),
                rawSql: input.rawTable ? rawRef(s.source.physicalName) : null,
              },
            ]),
        );
        try {
          const plan = compileRule(definition, columns);
          if (plan.kind !== 'row') {
            fail('Only row-level rules can select rows to remove (use deduplicate for duplicates)');
          } else {
            if (plan.needsRaw) needsRaw = true;
            removeWhere(`(${plan.applies}) AND (${plan.fails})`);
          }
        } catch (error) {
          if (error instanceof RuleDefinitionError) fail(error.message);
          throw error;
        }
        break;
      }
      case 'deduplicate': {
        const kept = state.filter((s) => !s.removed);
        const keys = op.keyColumns.length > 0 ? unique(op.keyColumns, index).map(column) : kept;
        const partition = keys.map(ref).join(', ');
        const order = `_row_id ${op.keep === 'first' ? 'ASC' : 'DESC'}`;
        const rank = `row_number() OVER (PARTITION BY (_del IS NULL), ${partition} ORDER BY ${order})`;
        // Explicit keys: rows with a missing key part are not duplicates (like the unique rule).
        // Whole-row duplicates treat NULLs as equal (like the duplicate_rows rule).
        const complete =
          op.keyColumns.length > 0
            ? keys.map((k) => `${ref(k)} IS NOT NULL`).join(' AND ')
            : 'true';
        const rn = `_rn${index}`;
        removeWhere(`${q(rn)} > 1`, {
          temps: new Map([[rn, `CASE WHEN _del IS NULL AND ${complete} THEN ${rank} END`]]),
        });
        break;
      }
      case 'rename_column': {
        const c = column(op.column);
        if (op.newName !== c.name && state.some((s) => !s.removed && s.name === op.newName)) {
          fail(`A column named "${op.newName}" already exists`);
        }
        c.name = op.newName;
        operations.push({ index, type: op.type, flag: null });
        break;
      }
      case 'drop_column': {
        const c = column(op.column);
        if (state.filter((s) => !s.removed).length === 1) fail('The last column cannot be removed');
        c.removed = true;
        operations.push({ index, type: op.type, flag: null });
        break;
      }
    }
  });

  // ─── Render ────────────────────────────────────────────────────────────────
  const physical = input.columns.map((c) => c.physicalName);
  const raws = needsRaw && input.rawTable ? physical.map((p) => `_r_${p}`) : [];
  const base =
    `SELECT t._row_id, NULL::int AS _del, ${physical.map((p) => `t.${q(p)}`).join(', ')}` +
    (raws.length > 0 ? `, ${physical.map((p) => `r.${q(p)} AS ${rawRef(p)}`).join(', ')}` : '') +
    ` FROM ${input.sourceTable} t` +
    (raws.length > 0 ? ` LEFT JOIN ${input.rawTable} r ON r._row_id = t._row_id` : '');

  const ctes = [`s0 AS (${base})`];
  const carried = ['_row_id', '_del', ...physical, ...raws];
  stages.forEach((stage, i) => {
    const list = [
      ...carried.map((c) => {
        const override = stage.overrides.get(c);
        return override ? `${override} AS ${q(c)}` : q(c);
      }),
      ...[...stage.adds, ...stage.temps].map(([name, sql]) => `${sql} AS ${q(name)}`),
    ];
    ctes.push(`s${i + 1} AS (SELECT ${list.join(', ')} FROM s${i})`);
    carried.push(...stage.adds.keys());
  });

  return {
    withClause: `WITH ${ctes.join(', ')}`,
    finalStage: `s${stages.length}`,
    columns: state.map((s) => ({
      ordinal: s.source.ordinal,
      originalName: s.source.originalName,
      name: s.name,
      physicalName: s.source.physicalName,
      dataType: s.dataType,
      source: s.source,
      modified: s.modified,
      removed: s.removed,
    })),
    operations,
  };
}

/** `SELECT _row_id, <typed columns> FROM final WHERE kept` – the new version's content. */
export function resultSelect(compiled: CompiledCleaning): string {
  const columns = compiled.columns
    .filter((c) => !c.removed)
    .map((c) => `${q(c.physicalName)}::${SQL_TYPE[c.dataType]} AS ${q(c.physicalName)}`);
  return `${compiled.withClause} SELECT _row_id, ${columns.join(', ')} FROM ${compiled.finalStage} WHERE _del IS NULL`;
}

/** One scan: total rows, kept rows, and per operation changed/removed rows. */
export function impactSelect(compiled: CompiledCleaning): string {
  const parts = ['count(*) AS total', 'count(*) FILTER (WHERE _del IS NULL) AS kept'];
  for (const op of compiled.operations) {
    if (op.flag) parts.push(`count(*) FILTER (WHERE ${q(op.flag)}) AS a${op.index}`);
    parts.push(`count(*) FILTER (WHERE _del = ${op.index}) AS d${op.index}`);
  }
  return `${compiled.withClause} SELECT ${parts.join(', ')} FROM ${compiled.finalStage}`;
}

function unique<T>(values: readonly T[], index: number): T[] {
  if (new Set(values).size !== values.length) {
    throw new CleaningCompileError(index, 'A column or format is listed more than once');
  }
  return [...values];
}

function typedLiteral(
  type: ColumnDataType,
  value: string,
  fail: (message: string) => never,
): string {
  const v = value.trim();
  switch (type) {
    case 'TEXT':
      if (value === '') fail('The fill value must not be empty');
      return sqlString(value);
    case 'INTEGER':
      return INTEGER.test(v) ? `${v}::bigint` : fail(`"${value}" is not an integer`);
    case 'DECIMAL':
      return NUMBER.test(v)
        ? `${v}::numeric`
        : fail(`"${value}" is not a number (use . for decimals)`);
    case 'BOOLEAN':
      if (v === 'true' || v === 'false') return v;
      return fail(`"${value}" is not true or false`);
    case 'DATE':
      if (!DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))
        fail(`"${value}" is not a date (yyyy-MM-dd)`);
      return `DATE ${sqlString(v)}`;
    case 'TIMESTAMP':
      if (!TIMESTAMP.test(v) || Number.isNaN(Date.parse(v.replace(' ', 'T'))))
        fail(`"${value}" is not a date-time (yyyy-MM-ddTHH:mm)`);
      return `TIMESTAMP ${sqlString(v.replace('T', ' '))}`;
  }
}

/** Text → type with the import candidates of that type, trying each layout in order. */
function parseAs(type: ColumnType, value: string, locale: NumberLocale, timezone: string): string {
  if (type === 'TEXT') return `NULLIF(${value}, '')`;
  const trimmed = `NULLIF(btrim(${value}), '')`;
  const attempts = candidatesFor(locale)
    .filter((c) => c.type === type)
    .map(
      (c) =>
        `CASE WHEN ${trimmed} ~* '${c.pattern}' THEN ${c.cast(trimmed).replaceAll('$tz', sqlString(timezone))} END`,
    );
  return attempts.length === 1 ? attempts[0]! : `coalesce(${attempts.join(', ')})`;
}
