import type {
  Evidence,
  Finding,
  HypothesisStatus,
  QueryColumn,
  ReportParagraph,
  ReportSegment,
} from '@insightai/contracts';
import { formatDate, formatValue, type Lang } from '../../ai/answer-text';

/**
 * Deterministic text of the investigation report (docs/PHASE6_AI_ANALYST_DESIGN.md §2.8). Every
 * figure comes from a finding or its evidence and is emitted as a `value` segment tied to that
 * evidence. Text written by the LLM is accepted only through `renderGuarded`: placeholders for
 * figures, no digits or links of its own.
 */

export type Value = string | number | null;

const localeOf = (lang: Lang) => (lang === 'vi' ? 'vi-VN' : 'en-US');

/** Figures that are differences: shown with a sign. */
const SIGNED = new Set([
  'delta',
  'totalDelta',
  'effect',
  'rateEffect',
  'mixEffect',
  'firstLastDelta',
  'residual',
]);
/** In the metric's own unit and format. */
const MONEY = new Set([...SIGNED, 'current', 'baseline', 'value', 'total', 'previous']);
const RATIO = new Set(['share', 'deltaRatio', 'topShare', 'firstLastRatio']);
const SIGNED_RATIO = new Set(['deltaRatio', 'firstLastRatio']);
const STATISTIC = new Set(['r2', 'z', 'slope', 'hhi', 'gini']);
const COUNT = new Set([
  'rows',
  'members',
  'membersFor80',
  'count',
  'series',
  'anomalies',
  'points',
]);

/** Column of a metric in the evidence results (its name, unit and format). */
export function metricColumn(evidence: Evidence, metricKey: string | null): QueryColumn | null {
  const key = metricKey ?? evidence.queries[0]?.metrics[0] ?? null;
  if (!key) return null;
  for (const result of evidence.results) {
    const column = result.columns.find((c) => c.key === key && !c.comparison);
    if (column) return column;
  }
  return null;
}

/** Splits `paid_revenue.delta` / `top.0.share` into the metric key (if any) and the figure. */
function parseName(evidence: Evidence, name: string): { metric: string | null; field: string } {
  const parts = name.split('.');
  const field = parts[parts.length - 1]!;
  const prefix = parts.slice(0, -1).join('.');
  const isMetric =
    prefix !== '' &&
    evidence.results.some((r) => r.columns.some((c) => c.key === prefix && !c.comparison));
  return { metric: isMetric ? prefix : null, field };
}

const signed = (text: string, value: number) => (value > 0 ? `+${text}` : text);

/** Display text of one figure of a finding or of its evidence. */
export function formatFigure(
  field: string,
  value: Value,
  evidence: Evidence,
  metricKey: string | null,
  lang: Lang,
): string {
  const vi = lang === 'vi';
  if (value === null) return vi ? 'không có dữ liệu' : 'no data';
  if (field === 'member') return String(value);
  if (field === 'metric') return metricColumn(evidence, String(value))?.name ?? String(value);
  if (field === 'period') return formatDate(String(value), lang);
  if (field === 'direction') return directionWord(String(value), lang);
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (RATIO.has(field)) {
    const text = number.toLocaleString(localeOf(lang), {
      style: 'percent',
      maximumFractionDigits: 1,
    });
    return SIGNED_RATIO.has(field) ? signed(text, number) : text;
  }
  if (STATISTIC.has(field)) {
    return number.toLocaleString(localeOf(lang), { maximumFractionDigits: 2 });
  }
  if (COUNT.has(field)) return number.toLocaleString(localeOf(lang));
  const column = MONEY.has(field) ? metricColumn(evidence, metricKey) : null;
  const text = column
    ? formatValue(String(value), column, lang)
    : number.toLocaleString(localeOf(lang), { maximumFractionDigits: 2 });
  return SIGNED.has(field) ? signed(text, number) : text;
}

function directionWord(direction: string, lang: Lang): string {
  const words: Record<string, [string, string]> = {
    up: ['tăng', 'up'],
    down: ['giảm', 'down'],
    flat: ['đi ngang', 'flat'],
    high: ['cao bất thường', 'unusually high'],
    low: ['thấp bất thường', 'unusually low'],
  };
  const w = words[direction];
  return w ? w[lang === 'vi' ? 0 : 1] : direction;
}

/** Figure of an evidence by name (`total.delta`), or undefined when it does not exist. */
export function evidenceSegment(
  evidence: Evidence,
  name: string,
  lang: Lang,
): ReportSegment | undefined {
  if (!(name in evidence.values)) return undefined;
  const { metric, field } = parseName(evidence, name);
  return {
    type: 'value',
    text: formatFigure(field, evidence.values[name] ?? null, evidence, metric, lang),
    evidenceId: evidence.id,
    name,
  };
}

/** Parameter of a finding (`delta`, `member`), tied to the finding's evidence. */
export function findingSegment(
  finding: Finding,
  evidence: Evidence,
  param: string,
  lang: Lang,
): ReportSegment | undefined {
  if (param === 'evidenceId' || !(param in finding.params)) return undefined;
  const metric = typeof finding.params.metric === 'string' ? finding.params.metric : null;
  let value = finding.params[param] ?? null;
  // A member that is null is the series of the whole metric, not missing data.
  if (param === 'member' && value === null) value = lang === 'vi' ? 'tổng thể' : 'overall';
  return {
    type: 'value',
    text: formatFigure(param, value, evidence, metric, lang),
    evidenceId: evidence.id,
    name: param,
  };
}

// ─── Templates ───────────────────────────────────────────────────────────────

const TEMPLATES: Record<string, [vi: string, en: string]> = {
  snapshot: [
    'Ảnh chụp chỉ số gồm {rows} dòng kết quả.',
    'The metric snapshot has {rows} result row(s).',
  ],
  'metric_change.up': [
    '{metric} tăng {delta|abs} ({deltaRatio|abs}) so với kỳ so sánh.',
    '{metric} rose by {delta|abs} ({deltaRatio|abs}) compared with the baseline.',
  ],
  'metric_change.down': [
    '{metric} giảm {delta|abs} ({deltaRatio|abs}) so với kỳ so sánh.',
    '{metric} fell by {delta|abs} ({deltaRatio|abs}) compared with the baseline.',
  ],
  'metric_change.flat': [
    '{metric} gần như không đổi so với kỳ so sánh.',
    '{metric} stayed about the same as in the baseline.',
  ],
  'driver.same_direction': [
    '{member} đóng góp nhiều nhất vào thay đổi: {delta}, tức {share} trong tổng thay đổi {totalDelta}.',
    '{member} contributed most to the change: {delta}, {share} of the total change of {totalDelta}.',
  ],
  'driver.opposite_direction': [
    '{member} biến động ngược chiều với tổng: {delta} ({share} so với tổng thay đổi {totalDelta}).',
    '{member} moved against the total: {delta} ({share} of the total change of {totalDelta}).',
  ],
  'ratio_driver.mix': [
    'Thay đổi chủ yếu do cơ cấu: {member} tác động {effect} ({share}); hiệu ứng cơ cấu {mixEffect}, hiệu ứng tỷ lệ {rateEffect}.',
    'The change comes mainly from the mix: {member} contributed {effect} ({share}); mix effect {mixEffect}, rate effect {rateEffect}.',
  ],
  'ratio_driver.rate': [
    'Thay đổi chủ yếu do tỷ lệ trong từng nhóm: {member} tác động {effect} ({share}); hiệu ứng tỷ lệ {rateEffect}, hiệu ứng cơ cấu {mixEffect}.',
    'The change comes mainly from rates within groups: {member} contributed {effect} ({share}); rate effect {rateEffect}, mix effect {mixEffect}.',
  ],
  'trend.up': [
    '{metric} có xu hướng tăng (thay đổi từ đầu đến cuối kỳ {firstLastRatio}, R² {r2}).',
    '{metric} trends upwards (first-to-last change {firstLastRatio}, R² {r2}).',
  ],
  'trend.down': [
    '{metric} có xu hướng giảm (thay đổi từ đầu đến cuối kỳ {firstLastRatio}, R² {r2}).',
    '{metric} trends downwards (first-to-last change {firstLastRatio}, R² {r2}).',
  ],
  'trend.flat': ['{metric} đi ngang trong kỳ.', '{metric} stayed flat over the period.'],
  'concentration.high': [
    'Giá trị tập trung: {member} chiếm {topShare}; {membersFor80} trên {members} thành viên tạo nên phần lớn tổng.',
    'Values are concentrated: {member} accounts for {topShare}; {membersFor80} of {members} members make up most of the total.',
  ],
  'concentration.spread': [
    'Giá trị phân tán: thành viên lớn nhất là {member} với {topShare}.',
    'Values are spread out: the largest member, {member}, has {topShare}.',
  ],
  'anomaly.high': [
    'Điểm cao bất thường ở {member} ngày {period}: {value} (z {z}); có {count} điểm bất thường.',
    'Unusually high value for {member} on {period}: {value} (z {z}); {count} unusual point(s) in total.',
  ],
  'anomaly.low': [
    'Điểm thấp bất thường ở {member} ngày {period}: {value} (z {z}); có {count} điểm bất thường.',
    'Unusually low value for {member} on {period}: {value} (z {z}); {count} unusual point(s) in total.',
  ],
};

/** `{param}`, or `{param|abs}` where the sentence already says the direction (no ± sign). */
const TOKEN = /\{([a-zA-Z0-9]+)(\|abs)?\}/g;

/** Fills a trusted template; a parameter it cannot fill is an error of the template table. */
function fill(
  template: string,
  segment: (name: string) => ReportSegment | undefined,
): ReportSegment[] {
  const out: ReportSegment[] = [];
  let last = 0;
  for (const match of template.matchAll(TOKEN)) {
    if (match.index > last) out.push({ type: 'text', text: template.slice(last, match.index) });
    const filled = segment(match[1]!);
    out.push(
      !filled
        ? { type: 'text', text: '—' }
        : match[2]
          ? { ...filled, text: filled.text.replace(/^[+\-−]/, '') }
          : filled,
    );
    last = match.index + match[0].length;
  }
  if (last < template.length) out.push({ type: 'text', text: template.slice(last) });
  return out;
}

/** The deterministic sentence of a finding. */
export function findingText(finding: Finding, evidence: Evidence, lang: Lang): ReportParagraph {
  const template = TEMPLATES[finding.templateKey];
  const text = template
    ? template[lang === 'vi' ? 0 : 1]
    : lang === 'vi'
      ? 'Phát hiện ({kind}).'
      : 'Finding ({kind}).';
  const segments = fill(text, (name) =>
    name === 'kind'
      ? { type: 'text', text: finding.kind }
      : findingSegment(finding, evidence, name, lang),
  );
  return {
    source: 'template',
    segments: finding.verified
      ? segments
      : [
          ...segments,
          { type: 'text', text: lang === 'vi' ? ' (chưa kiểm chứng)' : ' (not verified)' },
        ],
  };
}

export const HYPOTHESIS_LABELS: Record<HypothesisStatus, [string, string]> = {
  SUPPORTED: [
    'Có bằng chứng ủng hộ (tương quan, không chứng minh nhân quả)',
    'Supported by the evidence (correlation, not proof of cause)',
  ],
  NOT_SUPPORTED: ['Không được dữ liệu ủng hộ', 'Not supported by the data'],
  INCONCLUSIVE: ['Chưa đủ dữ liệu', 'Not enough data'],
  UNTESTED: ['Chưa kiểm định', 'Not tested'],
};

const LIMITATIONS: Record<string, [string, string]> = {
  NO_DATA: ['Không có dữ liệu cho một phần phân tích.', 'Part of the analysis had no data.'],
  TRUNCATED: [
    'Kết quả bị cắt bớt do giới hạn số dòng.',
    'Results were truncated by the row limit.',
  ],
  POLICY_FILTERED: [
    'Chính sách truy cập đã ẩn một phần dữ liệu của bạn.',
    'Access policies hid part of the data from you.',
  ],
  TOTAL_MISMATCH: [
    'Tổng theo thành viên không khớp tổng chung.',
    'The sum over members does not match the overall total.',
  ],
  ZERO_BASELINE: [
    'Kỳ so sánh bằng không: không tính được tỷ lệ thay đổi.',
    'The baseline is zero: no relative change can be computed.',
  ],
  ZERO_TOTAL: ['Tổng bằng không: không tính được tỷ trọng.', 'The total is zero: no shares.'],
  NOT_ADDITIVE: [
    'Chỉ số không cộng dồn được theo thành viên.',
    'The metric cannot be added up across members.',
  ],
  LOW_SAMPLE: [
    'Ít điểm dữ liệu: kết quả kém tin cậy.',
    'Few data points: results are less reliable.',
  ],
  GAPS: ['Chuỗi thời gian có khoảng trống.', 'The time series has gaps.'],
  PARTIAL_PERIOD: [
    'Kỳ phân tích chưa kết thúc (dữ liệu chưa đầy đủ).',
    'The period is not over yet (incomplete data).',
  ],
  CONSTANT_SERIES: ['Chuỗi giá trị không đổi.', 'The series is constant.'],
  NEGATIVE_VALUES: ['Có giá trị âm.', 'Some values are negative.'],
  NULL_VALUES: ['Có giá trị trống.', 'Some values are empty.'],
};

export function limitationText(code: string, lang: Lang): string {
  const text = LIMITATIONS[code];
  if (text) return text[lang === 'vi' ? 0 : 1];
  return lang === 'vi' ? `Hạn chế: ${code}.` : `Limitation: ${code}.`;
}

// ─── Guarded LLM text ────────────────────────────────────────────────────────

/** Any decimal digit, in any script (ASCII, full-width, Arabic-Indic…). */
const DIGIT = /\p{Nd}/u;
const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|vn|io)\b/i;
const PLACEHOLDER = /\{\{\s*(ev|finding)\s*:\s*([a-z][0-9]{1,3})\.([A-Za-z0-9_.:]+?)\s*\}\}/g;

export type PlaceholderResolver = (
  kind: 'ev' | 'finding',
  alias: string,
  name: string,
) => ReportSegment | undefined;

/**
 * Text written by the LLM, with `{{ev:<alias>.<name>}}` / `{{finding:<alias>.<param>}}` for every
 * figure. Null (use the template) when it is empty or too long, contains a digit or a link of its
 * own, a malformed or unknown placeholder.
 */
export function renderGuarded(
  text: string,
  maxLength: number,
  resolve: PlaceholderResolver,
): ReportSegment[] | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  const rest = trimmed.replace(PLACEHOLDER, '');
  if (DIGIT.test(rest) || LINK.test(rest) || rest.includes('{') || rest.includes('}')) return null;

  const out: ReportSegment[] = [];
  let last = 0;
  for (const match of trimmed.matchAll(PLACEHOLDER)) {
    const segment = resolve(match[1] as 'ev' | 'finding', match[2]!, match[3]!);
    if (!segment) return null;
    if (match.index > last) out.push({ type: 'text', text: trimmed.slice(last, match.index) });
    out.push(segment);
    last = match.index + match[0].length;
  }
  if (last < trimmed.length) out.push({ type: 'text', text: trimmed.slice(last) });
  return out;
}
