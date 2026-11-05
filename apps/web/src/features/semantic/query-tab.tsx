import {
  type CompiledQuery,
  DATE_RANGE_PRESETS,
  Permission,
  type QueryColumn,
  type SemanticModelDetail,
  type SemanticQuery,
  type SemanticQueryResult,
  type TimeGranularity,
  TIME_GRANULARITIES,
} from '@insightai/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Code2, Play } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/input';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { orgKey, useActiveOrganization, usePermission } from '../organizations/use-organization';
import { formatCell } from './format-cell';
import { rejectionReason, semanticApi } from './semantic-api';

/** Test query: pick metrics, dimensions and a period, run it, see the result and the SQL. */
export function QueryTab({ model }: { model: SemanticModelDetail }) {
  const { t } = useTranslation();
  const { organizationId } = useActiveOrganization();
  const canCompile = usePermission(Permission.SEMANTIC_WRITE);
  const catalog = useQuery({
    queryKey: orgKey(organizationId, 'catalog', model.key, model.revision),
    queryFn: () => semanticApi.catalog(model.key),
  });
  const [metrics, setMetrics] = useState<string[]>([]);
  const [dimensions, setDimensions] = useState<string[]>([]);
  const [preset, setPreset] = useState<string>('');
  const [granularity, setGranularity] = useState<TimeGranularity | ''>('');
  const [compare, setCompare] = useState<'' | 'previous_period' | 'same_period_last_year'>('');
  const [showSql, setShowSql] = useState(false);

  const query = (): SemanticQuery => ({
    model: model.key,
    metrics,
    dimensions,
    ...(preset || granularity
      ? {
          timeDimension: {
            ...(preset
              ? { dateRange: { preset: preset as (typeof DATE_RANGE_PRESETS)[number] } }
              : {}),
            ...(granularity ? { granularity } : {}),
            ...(compare && !granularity ? { compareTo: compare } : {}),
          },
        }
      : {}),
    limit: 200,
  });
  const run = useMutation({ mutationFn: () => semanticApi.query(query()) });
  const compile = useMutation({ mutationFn: () => semanticApi.compile(query()) });

  if (catalog.isError) return <Alert variant="destructive">{errorMessage(t, catalog.error)}</Alert>;
  if (!catalog.data) return <p className="text-muted-foreground text-sm">{t('common.loading')}</p>;

  const toggle = (list: string[], value: string, set: (v: string[]) => void, max: number) =>
    set(
      list.includes(value)
        ? list.filter((v) => v !== value)
        : list.length < max
          ? [...list, value]
          : list,
    );
  const reasonText = (error: unknown) => {
    const reason = rejectionReason(error);
    return reason
      ? t(`semantic.reasons.${reason}`, { defaultValue: errorMessage(t, error) })
      : errorMessage(t, error);
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <Picker
          title={t('semantic.pickMetrics')}
          empty={t('semantic.noPublishedMetrics')}
          items={catalog.data.metrics.map((m) => ({
            key: m.key,
            label: m.label,
            hint: m.unit ?? '',
          }))}
          selected={metrics}
          onToggle={(k) => toggle(metrics, k, setMetrics, 5)}
        />
        <Picker
          title={t('semantic.pickDimensions')}
          empty="—"
          items={catalog.data.dimensions
            .filter((d) => d.type === 'CATEGORICAL')
            .map((d) => ({ key: d.key, label: d.name, hint: d.key }))}
          selected={dimensions}
          onToggle={(k) => toggle(dimensions, k, setDimensions, 3)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t('semantic.period')} hint={t('semantic.periodHint')}>
          <NativeSelect value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="">{t('semantic.allTime')}</option>
            {DATE_RANGE_PRESETS.map((p) => (
              <option key={p} value={p}>
                {t(`semantic.presets.${p}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t('semantic.granularity')}>
          <NativeSelect
            value={granularity}
            onChange={(e) => setGranularity(e.target.value as TimeGranularity | '')}
          >
            <option value="">{t('semantic.none')}</option>
            {TIME_GRANULARITIES.map((g) => (
              <option key={g} value={g}>
                {t(`semantic.granularities.${g}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t('semantic.compareTo')}>
          <NativeSelect
            value={compare}
            disabled={!preset || granularity !== ''}
            onChange={(e) => setCompare(e.target.value as typeof compare)}
          >
            <option value="">{t('semantic.none')}</option>
            <option value="previous_period">{t('semantic.compare.previous_period')}</option>
            <option value="same_period_last_year">
              {t('semantic.compare.same_period_last_year')}
            </option>
          </NativeSelect>
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => run.mutate()} disabled={metrics.length === 0 || run.isPending}>
          <Play />
          {t('semantic.run')}
        </Button>
        {canCompile && (
          <Button
            variant="outline"
            disabled={metrics.length === 0 || compile.isPending}
            onClick={() => {
              setShowSql(true);
              compile.mutate();
            }}
          >
            <Code2 />
            {t('semantic.showSql')}
          </Button>
        )}
      </div>

      {run.isError && <Alert variant="destructive">{reasonText(run.error)}</Alert>}
      {run.data && <ResultTable result={run.data} />}
      {showSql && compile.isError && (
        <Alert variant="destructive">{reasonText(compile.error)}</Alert>
      )}
      {showSql && compile.data && <SqlView compiled={compile.data} />}
    </div>
  );
}

function Picker({
  title,
  empty,
  items,
  selected,
  onToggle,
}: {
  title: string;
  empty: string;
  items: { key: string; label: string; hint: string }[];
  selected: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <fieldset className="bg-card rounded-xl border p-4">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {items.map((item) => (
            <label
              key={item.key}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm',
                selected.includes(item.key) && 'border-primary bg-primary/5',
              )}
            >
              <input
                type="checkbox"
                checked={selected.includes(item.key)}
                onChange={() => onToggle(item.key)}
              />
              {item.label}
              {item.hint && <span className="text-muted-foreground text-xs">{item.hint}</span>}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function ResultTable({ result }: { result: SemanticQueryResult }) {
  const { t, i18n } = useTranslation();
  const label = (c: QueryColumn) =>
    c.comparison
      ? t('semantic.previousOf', { name: c.name })
      : c.kind === 'time'
        ? `${c.name} (${t(`semantic.granularities.${c.granularity}`)})`
        : c.name;
  return (
    <div className="space-y-2">
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        {result.dateRange && <span>{t('semantic.rangeLabel', result.dateRange)}</span>}
        {result.compareRange && <span>· {t('semantic.compareLabel', result.compareRange)}</span>}
        {result.metrics.map((m) => (
          <Badge key={m.key} variant="outline">
            {m.key} v{m.version}
          </Badge>
        ))}
        {result.cached && <Badge variant="secondary">{t('semantic.cached')}</Badge>}
        {result.policiesApplied.length > 0 && (
          <span>{t('semantic.policiesApplied', { names: result.policiesApplied.join(', ') })}</span>
        )}
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              {result.columns.map((c, i) => (
                <th
                  key={i}
                  className={cn(
                    'text-muted-foreground px-3 py-2 text-left text-xs font-medium',
                    (c.kind === 'metric' || c.kind === 'measure') && 'text-right',
                  )}
                >
                  {label(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, r) => (
              <tr key={r} className="border-t">
                {row.map((value, i) => {
                  const column = result.columns[i]!;
                  const numeric = column.kind === 'metric' || column.kind === 'measure';
                  return (
                    <td
                      key={i}
                      className={cn(
                        'px-3 py-1.5',
                        numeric && 'text-right tabular-nums',
                        column.comparison && 'text-muted-foreground',
                      )}
                    >
                      {formatCell(value, column, i18n.language)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.rows.length === 0 && (
        <p className="text-muted-foreground text-sm">{t('semantic.noRows')}</p>
      )}
      {result.truncated && (
        <p className="text-muted-foreground text-xs">{t('semantic.truncated')}</p>
      )}
    </div>
  );
}

export function SqlView({ compiled }: { compiled: CompiledQuery }) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2" aria-label={t('semantic.showSql')}>
      <pre className="bg-muted max-h-80 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
        {compiled.sql}
      </pre>
      {compiled.params.length > 0 && (
        <p className="text-muted-foreground font-mono text-xs">
          {compiled.params.map((p, i) => `$${i + 1} = ${JSON.stringify(p)}`).join(' · ')}
        </p>
      )}
    </section>
  );
}
