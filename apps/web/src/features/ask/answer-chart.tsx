import type { ChartSpec, QueryColumn, SemanticQueryResult } from '@insightai/contracts';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDecimal, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { formatCell } from '../semantic/format-cell';

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'];
const MAX_SERIES = COLORS.length;

/** Chart chosen by the server's rules (`answer.chart`); the table is always available too. */
export function AnswerChart({ spec, result }: { spec: ChartSpec; result: SemanticQueryResult }) {
  if (result.rows.length === 0) return null;
  if (spec.type === 'kpi') return <KpiChart spec={spec} result={result} />;
  if ((spec.type === 'line' || spec.type === 'bar') && spec.x) {
    return <XyChart type={spec.type} x={spec.x} series={spec.series} result={result} />;
  }
  return null;
}

function KpiChart({ spec, result }: { spec: ChartSpec; result: SemanticQueryResult }) {
  const { t, i18n } = useTranslation();
  const row = result.rows[0]!;
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {spec.series.map((key) => {
        const i = result.columns.findIndex((c) => c.key === key && !c.comparison);
        const p = result.columns.findIndex((c) => c.key === key && c.comparison);
        if (i < 0) return null;
        const column = result.columns[i]!;
        const value = row[i] ?? null;
        const previous = p >= 0 ? (row[p] ?? null) : null;
        const delta =
          value !== null && previous !== null && Number(previous) !== 0
            ? (Number(value) - Number(previous)) / Math.abs(Number(previous))
            : null;
        return (
          <li key={key} className="bg-muted/40 rounded-lg border p-4">
            <p className="text-muted-foreground text-xs font-medium">{column.name}</p>
            <p className="text-2xl font-semibold tabular-nums">
              {formatCell(value, column, i18n.language)}
            </p>
            {p >= 0 && (
              <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                {delta !== null && (
                  <span
                    className={cn(
                      'flex items-center gap-1 font-medium',
                      delta >= 0 ? 'text-success' : 'text-destructive',
                    )}
                  >
                    {delta >= 0 ? (
                      <TrendingUp className="size-3" />
                    ) : (
                      <TrendingDown className="size-3" />
                    )}
                    {formatPercent(delta, i18n.language)}
                  </span>
                )}
                {t('semantic.previousValue', {
                  value: formatCell(previous, column, i18n.language),
                })}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const W = 640;
const H = 240;
const PAD = { top: 12, right: 12, bottom: 36, left: 64 };

/** Line (time) or bar (category) chart in plain SVG; values are exact decimals parsed once. */
function XyChart({
  type,
  x,
  series,
  result,
}: {
  type: 'line' | 'bar';
  x: string;
  series: string[];
  result: SemanticQueryResult;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const xIndex = result.columns.findIndex((c) => c.key === x);
  const lines = series
    .slice(0, MAX_SERIES)
    .map((key) => result.columns.findIndex((c) => c.key === key && !c.comparison))
    .filter((i) => i >= 0);
  if (xIndex < 0 || lines.length === 0) return null;
  const xColumn = result.columns[xIndex]!;
  const rows = type === 'line' ? [...result.rows].sort(byText(xIndex)) : result.rows;

  const values = rows.flatMap((r) => lines.map((i) => Number(r[i] ?? 0)));
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + innerH - ((v - min) / span) * innerH;
  const step = innerW / Math.max(rows.length, 1);
  const cx = (r: number) => PAD.left + step * r + step / 2;
  const ticks = [min, min + span / 2, max];
  const labelEvery = Math.ceil(rows.length / 8);
  const xLabel = (v: string | null) =>
    v === null ? '—' : xColumn.type === 'DATE' ? formatDate(v, xColumn, lang) : v;
  const valueLabel = (v: number, column: QueryColumn) =>
    column.format === 'percent'
      ? formatPercent(v, lang)
      : formatDecimal(String(v), lang, Math.abs(v) >= 100 ? 0 : 2);

  return (
    <figure className="space-y-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={t('ask.chartLabel', {
          series: lines.map((i) => result.columns[i]!.name).join(', '),
          x: xColumn.name,
        })}
      >
        {ticks.map((v, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--border)"
              strokeDasharray={v === 0 ? undefined : '3 3'}
            />
            <text
              x={PAD.left - 6}
              y={y(v)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {valueLabel(v, result.columns[lines[0]!]!)}
            </text>
          </g>
        ))}
        {rows.map((r, i) =>
          i % labelEvery === 0 ? (
            <text
              key={i}
              x={cx(i)}
              y={H - PAD.bottom + 16}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {truncate(xLabel(r[xIndex] ?? null), 14)}
            </text>
          ) : null,
        )}
        {type === 'bar'
          ? lines.map((col, s) => {
              const barW = (step * 0.7) / lines.length;
              return rows.map((r, i) => {
                const v = Number(r[col] ?? 0);
                const top = Math.min(y(v), y(0));
                return (
                  <rect
                    key={`${s}-${i}`}
                    x={cx(i) - (step * 0.7) / 2 + barW * s}
                    y={top}
                    width={Math.max(barW - 2, 1)}
                    height={Math.max(Math.abs(y(v) - y(0)), 1)}
                    rx={2}
                    fill={COLORS[s]}
                  >
                    <title>{`${xLabel(r[xIndex] ?? null)}: ${formatCell(r[col] ?? null, result.columns[col]!, lang)}`}</title>
                  </rect>
                );
              });
            })
          : lines.map((col, s) => (
              <g key={s}>
                <polyline
                  fill="none"
                  stroke={COLORS[s]}
                  strokeWidth={2}
                  points={rows.map((r, i) => `${cx(i)},${y(Number(r[col] ?? 0))}`).join(' ')}
                />
                {rows.map((r, i) => (
                  <circle key={i} cx={cx(i)} cy={y(Number(r[col] ?? 0))} r={3} fill={COLORS[s]}>
                    <title>{`${xLabel(r[xIndex] ?? null)}: ${formatCell(r[col] ?? null, result.columns[col]!, lang)}`}</title>
                  </circle>
                ))}
              </g>
            ))}
      </svg>
      {lines.length > 1 && (
        <figcaption className="text-muted-foreground flex flex-wrap gap-3 text-xs">
          {lines.map((col, s) => (
            <span key={col} className="flex items-center gap-1">
              <span className="size-2.5 rounded-sm" style={{ background: COLORS[s] }} />
              {result.columns[col]!.name}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

const byText = (i: number) => (a: (string | null)[], b: (string | null)[]) =>
  (a[i] ?? '').localeCompare(b[i] ?? '');

const truncate = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

function formatDate(iso: string, column: QueryColumn, lang: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  if (column.granularity === 'year') return y ?? iso;
  if (column.granularity === 'month' || column.granularity === 'quarter') return `${m}/${y}`;
  return lang === 'vi' ? `${d}/${m}` : `${m}/${d}`;
}
