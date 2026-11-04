import {
  type Catalog,
  DATE_RANGE_PRESETS,
  type SemanticModelDetail,
  type SemanticQueryResult,
} from '@insightai/contracts';
import { useQueries, useQuery } from '@tanstack/react-query';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/ui/alert';
import { NativeSelect } from '@/components/ui/input';
import { errorMessage } from '@/lib/errors';
import { formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { orgKey, useActiveOrganization } from '../organizations/use-organization';
import { formatCell } from './format-cell';
import { rejectionReason, semanticApi } from './semantic-api';

type Preset = (typeof DATE_RANGE_PRESETS)[number];
const MAX_CARDS = 12;

/**
 * KPI cards: each published metric for the chosen period, compared with the previous period
 * when the metric has a time dimension. One query per metric (their time dimensions may differ).
 */
export function KpiTab({ model }: { model: SemanticModelDetail }) {
  const { t } = useTranslation();
  const { organizationId } = useActiveOrganization();
  const [preset, setPreset] = useState<Preset>('this_month');
  const catalog = useQuery({
    queryKey: orgKey(organizationId, 'catalog', model.key, model.revision),
    queryFn: () => semanticApi.catalog(model.key),
  });
  const metrics = (catalog.data?.metrics ?? []).slice(0, MAX_CARDS);
  const results = useQueries({
    queries: metrics.map((m) => ({
      queryKey: orgKey(organizationId, 'kpi', model.key, model.revision, m.key, m.version, preset),
      queryFn: () =>
        semanticApi.query({
          model: model.key,
          metrics: [m.key],
          ...(m.timeDimension
            ? { timeDimension: { dateRange: { preset }, compareTo: 'previous_period' as const } }
            : {}),
        }),
      retry: false,
    })),
  });

  if (catalog.isError) return <Alert variant="destructive">{errorMessage(t, catalog.error)}</Alert>;
  if (!catalog.data) return <p className="text-muted-foreground text-sm">{t('common.loading')}</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">{t('semantic.kpiHint')}</p>
        <NativeSelect
          aria-label={t('semantic.period')}
          className="h-8 w-auto"
          value={preset}
          onChange={(e) => setPreset(e.target.value as Preset)}
        >
          {DATE_RANGE_PRESETS.map((p) => (
            <option key={p} value={p}>
              {t(`semantic.presets.${p}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {metrics.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
          {t('semantic.noPublishedMetrics')}
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {metrics.map((m, i) => (
            <KpiCard
              key={m.key}
              metric={m}
              result={results[i]?.data}
              error={results[i]?.error ?? null}
              loading={results[i]?.isPending ?? true}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function KpiCard({
  metric,
  result,
  error,
  loading,
}: {
  metric: Catalog['metrics'][number];
  result: SemanticQueryResult | undefined;
  error: unknown;
  loading: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const row = result?.rows[0];
  const current = result && row ? { value: row[0] ?? null, column: result.columns[0]! } : null;
  const previous = result && row && result.columns[1]?.comparison ? (row[1] ?? null) : null;
  const delta =
    current?.value != null && previous != null && Number(previous) !== 0
      ? (Number(current.value) - Number(previous)) / Math.abs(Number(previous))
      : null;
  const reason = error ? rejectionReason(error) : null;

  return (
    <li className="bg-card flex flex-col gap-2 rounded-xl border p-5" aria-label={metric.label}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-muted-foreground text-sm font-medium">{metric.label}</h3>
        <span className="text-muted-foreground text-xs">v{metric.version}</span>
      </div>
      {loading ? (
        <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
      ) : error ? (
        <p className="text-destructive text-sm">
          {reason
            ? t(`semantic.reasons.${reason}`, { defaultValue: errorMessage(t, error) })
            : errorMessage(t, error)}
        </p>
      ) : (
        <>
          <p className="text-3xl font-semibold tabular-nums">
            {current ? formatCell(current.value, current.column, lang) : '—'}
          </p>
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
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
                {formatPercent(delta, lang)}
              </span>
            )}
            {result?.compareRange && current && (
              <span>
                {t('semantic.previousValue', { value: formatCell(previous, current.column, lang) })}
              </span>
            )}
            {!metric.timeDimension && <span>{t('semantic.allTime')}</span>}
          </div>
        </>
      )}
      {metric.businessDefinition && (
        <p className="text-muted-foreground mt-auto line-clamp-2 text-xs">
          {metric.businessDefinition}
        </p>
      )}
    </li>
  );
}
