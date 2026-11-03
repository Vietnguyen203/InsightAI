import { type ColumnProfile, Permission } from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatDecimal, formatNumber, formatPercent } from '@/lib/format';
import { orgKey, useActiveOrganization, usePermission } from '../organizations/use-organization';
import { datasetsApi, isInProgress } from './datasets-api';

export function ProfileTab({ datasetId, versionId }: { datasetId: string; versionId: string }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const canWrite = usePermission(Permission.DATASET_WRITE);
  const key = orgKey(organizationId, 'dataset', datasetId, 'profile', versionId);

  const profile = useQuery({
    queryKey: key,
    queryFn: () => datasetsApi.profile(datasetId, versionId),
    refetchInterval: (query) => (isInProgress(query.state.data?.status) ? 2000 : false),
  });
  const retry = useMutation({
    mutationFn: () => datasetsApi.reprofile(datasetId, versionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  if (profile.isError) return <Alert variant="destructive">{errorMessage(t, profile.error)}</Alert>;
  if (!profile.data || isInProgress(profile.data.status)) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        {t('datasets.profile.pending')}
      </p>
    );
  }
  if (profile.data.status === 'FAILED') {
    return (
      <Alert variant="destructive" className="flex items-center justify-between gap-4">
        <span>{t('datasets.profile.failed')}</span>
        {canWrite && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
          >
            {t('datasets.profile.retry')}
          </Button>
        )}
      </Alert>
    );
  }

  const approximate = profile.data.columns.some((c) => c.approximate);
  return (
    <div className="space-y-4">
      <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
        {profile.data.computedAt && (
          <span>
            {t('datasets.profile.computedAt', {
              date: formatDateTime(profile.data.computedAt, i18n.language),
            })}
          </span>
        )}
        {approximate && <Badge variant="outline">{t('datasets.profile.approximate')}</Badge>}
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {profile.data.columns.map((column) => (
          <ColumnCard key={column.name} column={column} />
        ))}
      </div>
    </div>
  );
}

function ColumnCard({ column }: { column: ColumnProfile }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const missingRatio = column.rowCount > 0 ? column.nullCount / column.rowCount : 0;
  const numeric = column.dataType === 'INTEGER' || column.dataType === 'DECIMAL';
  const temporal = column.dataType === 'DATE' || column.dataType === 'TIMESTAMP';

  const stats: [string, string][] = [
    [
      t('datasets.profile.missing'),
      `${formatNumber(column.nullCount, lang)} (${formatPercent(missingRatio, lang)})`,
    ],
    [t('datasets.profile.distinct'), formatNumber(column.distinctCount, lang)],
  ];
  if (numeric) {
    if (column.min !== null)
      stats.push([t('datasets.profile.min'), formatDecimal(column.min, lang)]);
    if (column.percentiles)
      stats.push([t('datasets.profile.median'), formatDecimal(column.percentiles.p50, lang)]);
    if (column.mean) stats.push([t('datasets.profile.mean'), formatDecimal(column.mean, lang, 2)]);
    if (column.max !== null)
      stats.push([t('datasets.profile.max'), formatDecimal(column.max, lang)]);
    if (column.stddev)
      stats.push([t('datasets.profile.stddev'), formatDecimal(column.stddev, lang, 2)]);
  } else if (temporal) {
    if (column.min !== null) stats.push([t('datasets.profile.min'), column.min]);
    if (column.max !== null) stats.push([t('datasets.profile.max'), column.max]);
  } else if (column.length) {
    stats.push([
      t('datasets.profile.length'),
      `${column.length.min}–${column.length.max} (Ø ${formatDecimal(String(column.length.avg), lang, 1)})`,
    ]);
  }

  return (
    <section className="bg-card space-y-3 rounded-xl border p-4" aria-label={column.originalName}>
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-medium" title={column.originalName}>
            {column.originalName}
          </h3>
          <p className="text-muted-foreground truncate font-mono text-xs">{column.name}</p>
        </div>
        <Badge variant="secondary">{t(`datasets.types.${column.dataType}`)}</Badge>
      </header>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        {stats.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate text-right tabular-nums" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {numeric && column.histogram && column.histogram.length > 1 && (
        <Bars
          title={t('datasets.profile.histogram')}
          items={column.histogram.map((b) => ({
            label: `${formatDecimal(b.from, lang)} – ${formatDecimal(b.to, lang)}`,
            count: b.count,
          }))}
          vertical
        />
      )}
      {temporal && column.timeline && column.timeline.length > 0 && (
        <Bars
          title={t('datasets.profile.timeline')}
          items={column.timeline.map((p) => ({ label: p.period, count: p.count }))}
          vertical
        />
      )}
      {!numeric && !temporal && column.topValues.length > 0 && (
        <Bars
          title={t('datasets.profile.top')}
          items={column.topValues.slice(0, 5).map((v) => ({ label: v.value, count: v.count }))}
        />
      )}
    </section>
  );
}

/** Minimal bar chart (no chart library): horizontal for categories, vertical for distributions. */
function Bars({
  title,
  items,
  vertical = false,
}: {
  title: string;
  items: { label: string; count: number }[];
  vertical?: boolean;
}) {
  const { i18n } = useTranslation();
  const max = Math.max(1, ...items.map((i) => i.count));

  if (vertical) {
    return (
      <figure className="space-y-1">
        <figcaption className="text-muted-foreground text-xs">{title}</figcaption>
        <div className="flex h-16 items-end gap-px" role="list">
          {items.map((item, index) => (
            <div
              key={`${item.label}-${index}`}
              role="listitem"
              className="bg-primary/70 hover:bg-primary min-w-0 flex-1 rounded-t-sm"
              style={{ height: `${Math.max(item.count > 0 ? 4 : 0, (item.count / max) * 100)}%` }}
              title={`${item.label}: ${formatNumber(item.count, i18n.language)}`}
              aria-label={`${item.label}: ${formatNumber(item.count, i18n.language)}`}
            />
          ))}
        </div>
        {items.length > 1 && (
          <div className="text-muted-foreground flex justify-between gap-2 text-[10px] tabular-nums">
            <span className="truncate">{items[0]?.label.split(' – ')[0]}</span>
            <span className="truncate">{items.at(-1)?.label.split(' – ').at(-1)}</span>
          </div>
        )}
      </figure>
    );
  }

  return (
    <figure className="space-y-1">
      <figcaption className="text-muted-foreground text-xs">{title}</figcaption>
      <ul className="space-y-1">
        {items.map((item) => (
          <li
            key={item.label}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs"
          >
            <div className="relative h-5 overflow-hidden rounded-sm">
              <div
                className="bg-primary/20 absolute inset-y-0 left-0"
                style={{ width: `${(item.count / max) * 100}%` }}
              />
              <span className="relative block truncate px-1 leading-5" title={item.label}>
                {item.label}
              </span>
            </div>
            <span className="text-muted-foreground tabular-nums">
              {formatNumber(item.count, i18n.language)}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
