import type {
  ChartSpec,
  QueryColumn,
  SemanticQueryParsed,
  SemanticQueryResult,
} from '@insightai/contracts';

/**
 * Everything the user reads that contains numbers is produced here, deterministically, from the
 * query result (docs/SEMANTIC_LAYER_DESIGN.md §9.2). The LLM writes the narrative with
 * placeholders only; a narrative that contains digits of its own is discarded.
 */

export type Lang = 'vi' | 'en';

const localeOf = (lang: Lang) => (lang === 'vi' ? 'vi-VN' : 'en-US');

/** Exact decimal text → display text by column type, unit and format. */
export function formatValue(value: string | null, column: QueryColumn, lang: Lang): string {
  if (value === null) return lang === 'vi' ? 'không có dữ liệu' : 'no data';
  if (column.type === 'DATE') return formatDate(value, lang);
  if (column.type !== 'INTEGER' && column.type !== 'DECIMAL') return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  if (column.format === 'percent') {
    return number.toLocaleString(localeOf(lang), { style: 'percent', maximumFractionDigits: 1 });
  }
  const text = number.toLocaleString(localeOf(lang), {
    maximumFractionDigits: column.type === 'INTEGER' ? 0 : 2,
  });
  return column.unit ? `${text} ${column.unit}` : text;
}

export function formatDate(iso: string, lang: Lang): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return lang === 'vi' ? `${d}/${m}/${y}` : `${m}/${d}/${y}`;
}

export const formatPercentChange = (ratio: number, lang: Lang) =>
  `${ratio >= 0 ? '+' : ''}${ratio.toLocaleString(localeOf(lang), { style: 'percent', maximumFractionDigits: 1 })}`;

/** Named figures the narrative may reference as {{stat:<name>}}. */
export function computeStats(result: SemanticQueryResult, lang: Lang): Map<string, string> {
  const stats = new Map<string, string>();
  const values = result.columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (c.kind === 'metric' || c.kind === 'measure') && !c.comparison);
  const hasDims = result.columns.some((c) => c.kind === 'dimension' || c.kind === 'time');
  for (const { c, i } of values) {
    if (result.rows.length === 1 && !hasDims) {
      const previous = result.columns.findIndex((x) => x.key === c.key && x.comparison);
      const current = result.rows[0]![i];
      const before = previous >= 0 ? result.rows[0]![previous] : undefined;
      if (before !== undefined)
        stats.set(`previous:${c.key}`, formatValue(before ?? null, c, lang));
      if (current && before && Number(before) !== 0) {
        stats.set(
          `change:${c.key}`,
          formatPercentChange((Number(current) - Number(before)) / Math.abs(Number(before)), lang),
        );
      }
    }
    if (
      hasDims &&
      result.rows.length > 0 &&
      (c.type === 'INTEGER' || c.type === 'DECIMAL') &&
      additive(c)
    ) {
      const total = result.rows.reduce((sum, row) => sum + Number(row[i] ?? 0), 0);
      stats.set(`total:${c.key}`, formatValue(String(total), c, lang));
    }
  }
  stats.set('rows', String(result.rows.length));
  return stats;
}

/** Ratios and averages cannot be summed across rows. */
const additive = (c: QueryColumn) => c.format !== 'percent' && c.kind === 'metric';

const PLACEHOLDER = /\{\{\s*(cell|stat)\s*:\s*([^}]+?)\s*\}\}/g;

/**
 * Fills `{{cell:<row>.<columnKey>}}` and `{{stat:<name>}}`. Returns null when the narrative is
 * unusable: an unknown placeholder, or any digit outside placeholders (a number the LLM made up).
 */
export function renderNarrative(
  template: string,
  result: SemanticQueryResult,
  stats: Map<string, string>,
  lang: Lang,
): string | null {
  if (!template.trim() || template.length > 2000) return null;
  const withoutPlaceholders = template.replace(PLACEHOLDER, '');
  if (/[0-9]/.test(withoutPlaceholders)) return null;

  let failed = false;
  const text = template.replace(PLACEHOLDER, (_, kind: string, ref: string) => {
    if (kind === 'stat') {
      const value = stats.get(ref);
      if (value === undefined) failed = true;
      return value ?? '';
    }
    const dot = ref.indexOf('.');
    const row = Number(ref.slice(0, dot));
    const key = ref.slice(dot + 1);
    const columnIndex = result.columns.findIndex((c) => c.key === key && !c.comparison);
    const previous = key.endsWith(':previous')
      ? result.columns.findIndex((c) => c.key === key.slice(0, -':previous'.length) && c.comparison)
      : -1;
    const index = columnIndex >= 0 ? columnIndex : previous;
    const cells = Number.isInteger(row) ? result.rows[row] : undefined;
    if (dot < 0 || index < 0 || !cells) {
      failed = true;
      return '';
    }
    return formatValue(cells[index] ?? null, result.columns[index]!, lang);
  });
  return failed ? null : text;
}

/** Deterministic narrative used when the LLM's one is missing or rejected. */
export function fallbackNarrative(result: SemanticQueryResult, lang: Lang): string {
  const vi = lang === 'vi';
  if (result.rows.length === 0) return vi ? 'Không có dữ liệu phù hợp.' : 'No matching data.';
  const values = result.columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (c.kind === 'metric' || c.kind === 'measure') && !c.comparison);
  const dims = result.columns.filter((c) => c.kind === 'dimension' || c.kind === 'time');
  if (dims.length === 0) {
    const row = result.rows[0]!;
    const stats = computeStats(result, lang);
    return values
      .map(({ c, i }) => {
        const change = stats.get(`change:${c.key}`);
        const previous = stats.get(`previous:${c.key}`);
        const base = `${c.name}: ${formatValue(row[i] ?? null, c, lang)}`;
        if (!previous) return base;
        return vi
          ? `${base} (kỳ trước ${previous}${change ? `, thay đổi ${change}` : ''})`
          : `${base} (previous ${previous}${change ? `, change ${change}` : ''})`;
      })
      .join('. ')
      .concat('.');
  }
  const first = values[0];
  const count = result.rows.length;
  const intro = vi
    ? `Kết quả có ${count} dòng theo ${dims.map((d) => d.name).join(', ')}.`
    : `The result has ${count} row(s) by ${dims.map((d) => d.name).join(', ')}.`;
  if (!first) return intro;
  const top = [...result.rows].sort(
    (a, b) => Number(b[first.i] ?? -Infinity) - Number(a[first.i] ?? -Infinity),
  )[0]!;
  const label = dims.map((d) => {
    const i = result.columns.indexOf(d);
    return d.type === 'DATE' ? formatDate(top[i] ?? '', lang) : (top[i] ?? '—');
  });
  return vi
    ? `${intro} Cao nhất về ${first.c.name}: ${label.join(' · ')} (${formatValue(top[first.i] ?? null, first.c, lang)}).`
    : `${intro} Highest ${first.c.name}: ${label.join(' · ')} (${formatValue(top[first.i] ?? null, first.c, lang)}).`;
}

/** Chart by the shape of the result (the LLM does not choose it). */
export function chartFor(result: SemanticQueryResult): ChartSpec {
  const time = result.columns.find((c) => c.kind === 'time');
  const dims = result.columns.filter((c) => c.kind === 'dimension');
  const series = result.columns
    .filter((c) => (c.kind === 'metric' || c.kind === 'measure') && !c.comparison)
    .filter((c) => c.type === 'INTEGER' || c.type === 'DECIMAL')
    .map((c) => c.key);
  if (series.length === 0) return { type: 'table', x: null, series: [] };
  if (!time && dims.length === 0) return { type: 'kpi', x: null, series };
  if (time && dims.length === 0) return { type: 'line', x: time.key, series };
  if (!time && dims.length === 1 && result.rows.length <= 50)
    return { type: 'bar', x: dims[0]!.key, series };
  return { type: 'table', x: null, series };
}

/** How the question was understood, in words ("Doanh thu · theo Thành phố · 01/10–31/10/2026"). */
export function interpretedAs(
  query: SemanticQueryParsed,
  result: SemanticQueryResult,
  labels: Map<string, string>,
  lang: Lang,
): string {
  const vi = lang === 'vi';
  const parts = [query.metrics.map((k) => labels.get(k) ?? k).join(', ')];
  const dims = result.columns.filter((c) => c.kind === 'dimension').map((c) => c.name);
  if (dims.length) parts.push(`${vi ? 'theo' : 'by'} ${dims.join(', ')}`);
  const time = result.columns.find((c) => c.kind === 'time');
  if (time?.granularity) {
    const g = vi
      ? { day: 'ngày', week: 'tuần', month: 'tháng', quarter: 'quý', year: 'năm' }[time.granularity]
      : time.granularity;
    parts.push(`${vi ? 'theo' : 'by'} ${g}`);
  }
  if (result.dateRange) {
    parts.push(
      `${formatDate(result.dateRange.from, lang)} – ${formatDate(result.dateRange.to, lang)}`,
    );
  } else {
    parts.push(vi ? 'toàn bộ thời gian' : 'all time');
  }
  if (result.compareRange) {
    parts.push(
      `${vi ? 'so với' : 'vs'} ${formatDate(result.compareRange.from, lang)} – ${formatDate(result.compareRange.to, lang)}`,
    );
  }
  for (const f of query.filters) {
    parts.push(`${labels.get(f.member) ?? f.member} ${f.op} ${(f.values ?? []).join(', ')}`.trim());
  }
  return parts.join(' · ');
}
