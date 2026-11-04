import {
  type Metric,
  type MetricDetail,
  Permission,
  type SemanticModelDetail,
} from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { orgKey, useActiveOrganization, usePermission } from '../organizations/use-organization';
import { MetricEditor, type MetricFormValue } from './metric-editor';
import { rejectionReason, semanticApi } from './semantic-api';

/** Readable message for metric errors, including the planner's rejection reason on publish. */
function useErrorText() {
  const { t } = useTranslation();
  return (error: unknown) => {
    const reason = rejectionReason(error);
    return reason
      ? t(`semantic.reasons.${reason}`, { defaultValue: errorMessage(t, error) })
      : errorMessage(t, error);
  };
}

export function MetricsTab({ model }: { model: SemanticModelDetail }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const canWrite = usePermission(Permission.SEMANTIC_WRITE);
  const key = orgKey(organizationId, 'semantic-model', model.id, 'metrics');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const errorText = useErrorText();

  const metrics = useQuery({ queryKey: key, queryFn: () => semanticApi.metrics(model.id) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: (value: MetricFormValue) =>
      semanticApi.createMetric(model.id, { ...value, key: value.key ?? '' }),
    onSuccess: async (metric) => {
      await refresh();
      setCreating(false);
      setSelected(metric.id);
    },
  });

  if (metrics.isError) return <Alert variant="destructive">{errorMessage(t, metrics.error)}</Alert>;
  if (!metrics.data) return <p className="text-muted-foreground text-sm">{t('common.loading')}</p>;
  const list = metrics.data;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <section className="space-y-3" aria-labelledby="metric-list">
        <div className="flex items-center justify-between gap-2">
          <h2 id="metric-list" className="text-lg font-semibold">
            {t('semantic.metrics')}
          </h2>
          {canWrite && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCreating(true);
                setSelected(null);
              }}
            >
              <Plus />
              {t('semantic.addMetric')}
            </Button>
          )}
        </div>
        {list.length === 0 ? (
          <p className="text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">
            {t('semantic.noMetrics')}
          </p>
        ) : (
          <ul className="space-y-2">
            {list.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  aria-current={selected === m.id}
                  onClick={() => {
                    setSelected(m.id);
                    setCreating(false);
                  }}
                  className={cn(
                    'bg-card hover:border-primary/50 w-full rounded-lg border p-3 text-left transition-colors',
                    selected === m.id && 'border-primary ring-primary/20 ring-2',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">
                      {m.published?.label ?? m.draft?.label ?? m.key}
                    </span>
                    <MetricBadge metric={m} />
                  </div>
                  <div className="text-muted-foreground font-mono text-xs">{m.key}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div>
        {creating ? (
          <MetricEditor
            model={model}
            metrics={list}
            initial={null}
            withKey
            submitLabel={t('semantic.createMetric')}
            pending={create.isPending}
            error={create.isError ? errorText(create.error) : null}
            onSubmit={(value) => create.mutate(value)}
            onCancel={() => setCreating(false)}
          />
        ) : selected ? (
          <MetricPanel
            key={selected}
            metricId={selected}
            model={model}
            metrics={list}
            onChanged={() => void refresh()}
            onRemoved={() => {
              setSelected(null);
              void refresh();
            }}
          />
        ) : (
          <p className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
            {t('semantic.pickMetric')}
          </p>
        )}
      </div>
    </div>
  );
}

function MetricBadge({ metric }: { metric: Metric }) {
  const { t } = useTranslation();
  if (metric.status === 'DEPRECATED')
    return <Badge variant="secondary">{t('semantic.metricStatus.DEPRECATED')}</Badge>;
  if (metric.published) {
    return (
      <Badge variant="success">
        v{metric.published.versionNo}
        {metric.draft ? ` · ${t('semantic.hasDraft')}` : ''}
      </Badge>
    );
  }
  return <Badge variant="outline">{t('semantic.versionStatus.DRAFT')}</Badge>;
}

function MetricPanel({
  metricId,
  model,
  metrics,
  onChanged,
  onRemoved,
}: {
  metricId: string;
  model: SemanticModelDetail;
  metrics: Metric[];
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const canWrite = usePermission(Permission.SEMANTIC_WRITE);
  const canPublish = usePermission(Permission.SEMANTIC_PUBLISH);
  const key = orgKey(organizationId, 'metric', metricId);
  const [editing, setEditing] = useState(false);
  const errorText = useErrorText();

  const metric = useQuery({ queryKey: key, queryFn: () => semanticApi.metric(metricId) });
  const done = (detail: MetricDetail | null) => {
    if (detail) queryClient.setQueryData(key, detail);
    setEditing(false);
    onChanged();
  };
  const save = useMutation({
    mutationFn: (value: MetricFormValue) => {
      const current = metric.data!;
      return current.draft
        ? semanticApi.updateVersion(current.draft.id, value)
        : semanticApi.createVersion(current.id, value);
    },
    onSuccess: done,
  });
  const action = useMutation({
    mutationFn: async (kind: 'publish' | 'discard' | 'deprecate' | 'restore') => {
      const current = metric.data!;
      if (kind === 'publish') return semanticApi.publishVersion(current.draft!.id);
      if (kind === 'discard') return semanticApi.deleteDraft(current.draft!.id);
      return semanticApi.setMetricStatus(current.id, kind);
    },
    onSuccess: (detail) => (detail ? done(detail) : onRemoved()),
  });

  if (metric.isError) return <Alert variant="destructive">{errorMessage(t, metric.error)}</Alert>;
  if (!metric.data) return <p className="text-muted-foreground text-sm">{t('common.loading')}</p>;
  const data = metric.data;
  const shown = data.draft ?? data.published;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold">{shown?.label ?? data.key}</h3>
          <p className="text-muted-foreground font-mono text-xs">{data.key}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && !editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              {data.draft ? t('semantic.editDraft') : t('semantic.newVersion')}
            </Button>
          )}
          {data.draft && canWrite && (
            <Button
              size="sm"
              variant="ghost"
              disabled={action.isPending}
              onClick={() => {
                if (window.confirm(t('semantic.discardConfirm'))) action.mutate('discard');
              }}
            >
              {t('semantic.discardDraft')}
            </Button>
          )}
          {data.draft && canPublish && (
            <Button size="sm" disabled={action.isPending} onClick={() => action.mutate('publish')}>
              {t('semantic.publishVersion', { version: data.draft.versionNo })}
            </Button>
          )}
          {data.published && canPublish && (
            <Button
              size="sm"
              variant="ghost"
              disabled={action.isPending}
              onClick={() => action.mutate(data.status === 'ACTIVE' ? 'deprecate' : 'restore')}
            >
              {data.status === 'ACTIVE' ? t('semantic.deprecate') : t('semantic.restore')}
            </Button>
          )}
        </div>
      </header>
      {action.isError && <Alert variant="destructive">{errorText(action.error)}</Alert>}
      {data.status === 'DEPRECATED' && <Alert>{t('semantic.deprecatedHint')}</Alert>}

      {editing ? (
        <MetricEditor
          model={model}
          metrics={metrics}
          initial={shown}
          withKey={false}
          submitLabel={data.draft ? t('common.save') : t('semantic.createDraft')}
          pending={save.isPending}
          error={save.isError ? errorText(save.error) : null}
          onSubmit={(value) => save.mutate(value)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        shown && <VersionSummary version={shown} />
      )}

      <Synonyms
        modelId={model.id}
        member={data.key}
        phrases={data.synonyms}
        onChanged={() => void queryClient.invalidateQueries({ queryKey: key })}
      />

      <section className="space-y-2" aria-labelledby={`versions-${data.id}`}>
        <h4 id={`versions-${data.id}`} className="text-sm font-medium">
          {t('semantic.versions')}
        </h4>
        <ul className="divide-y rounded-lg border text-sm">
          {data.versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="font-medium">v{v.versionNo}</span>
              <Badge
                variant={
                  v.status === 'PUBLISHED'
                    ? 'success'
                    : v.status === 'DRAFT'
                      ? 'outline'
                      : 'secondary'
                }
              >
                {t(`semantic.versionStatus.${v.status}`)}
              </Badge>
              <span className="text-muted-foreground truncate">{v.label}</span>
              <span className="text-muted-foreground ml-auto text-xs">
                {formatDateTime(v.publishedAt ?? v.createdAt, i18n.language)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function VersionSummary({ version }: { version: MetricDetail['versions'][number] }) {
  const { t } = useTranslation();
  const def = version.definition;
  const rows: [string, string][] = [
    [t('semantic.metricType'), t(`semantic.metricTypes.${def.type}`)],
  ];
  if (def.type === 'SIMPLE') {
    rows.push([t('semantic.measure'), def.measure]);
    rows.push([
      t('semantic.metricFilters'),
      def.filters.length
        ? def.filters
            .map((f) => `${f.member} ${t(`semantic.ops.${f.op}`)} ${(f.values ?? []).join(', ')}`)
            .join(' · ')
        : '—',
    ]);
    rows.push([t('semantic.defaultTime'), def.timeDimension ?? '—']);
  } else if (def.type === 'RATIO') {
    rows.push(
      [t('semantic.numerator'), def.numerator],
      [t('semantic.denominator'), def.denominator],
    );
  } else {
    rows.push([t('semantic.derivedExpr'), def.expr]);
  }
  rows.push(
    [t('semantic.unit'), version.unit ?? '—'],
    [t('semantic.format'), t(`semantic.formats.${version.format}`)],
  );

  return (
    <div className="bg-card space-y-3 rounded-xl border p-4">
      <div className="flex items-center gap-2">
        <Badge variant={version.status === 'PUBLISHED' ? 'success' : 'outline'}>
          v{version.versionNo} · {t(`semantic.versionStatus.${version.status}`)}
        </Badge>
      </div>
      {version.businessDefinition && <p className="text-sm">{version.businessDefinition}</p>}
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono text-xs break-words sm:text-sm">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Synonyms({
  modelId,
  member,
  phrases,
  onChanged,
}: {
  modelId: string;
  member: string;
  phrases: string[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const { organizationId } = useActiveOrganization();
  const canWrite = usePermission(Permission.SEMANTIC_WRITE);
  const [phrase, setPhrase] = useState('');
  const all = useQuery({
    queryKey: orgKey(organizationId, 'semantic-model', modelId, 'synonyms'),
    queryFn: () => semanticApi.synonyms(modelId),
  });
  const add = useMutation({
    mutationFn: () => semanticApi.addSynonym(modelId, { member, phrase }),
    onSuccess: async () => {
      setPhrase('');
      await all.refetch();
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => semanticApi.removeSynonym(id),
    onSuccess: async () => {
      await all.refetch();
      onChanged();
    },
  });
  const own = (all.data ?? []).filter((s) => s.member === member);

  return (
    <section className="space-y-2" aria-labelledby={`synonyms-${member}`}>
      <h4 id={`synonyms-${member}`} className="text-sm font-medium">
        {t('semantic.synonyms')}
      </h4>
      <p className="text-muted-foreground text-xs">{t('semantic.synonymsHint')}</p>
      <div className="flex flex-wrap gap-2">
        {(all.data
          ? own.map((s) => ({ id: s.id, phrase: s.phrase }))
          : phrases.map((p) => ({ id: p, phrase: p }))
        ).map((s) => (
          <Badge key={s.id} variant="secondary" className="gap-1 pr-1">
            {s.phrase}
            {canWrite && all.data && (
              <button
                type="button"
                className="hover:text-destructive rounded"
                aria-label={t('semantic.removeSynonym', { phrase: s.phrase })}
                onClick={() => remove.mutate(s.id)}
              >
                <X className="size-3" />
              </button>
            )}
          </Badge>
        ))}
        {own.length === 0 && phrases.length === 0 && (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </div>
      {canWrite && (
        <form
          className="flex max-w-md gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (phrase.trim()) add.mutate();
          }}
        >
          <Input
            aria-label={t('semantic.addSynonym')}
            placeholder={t('semantic.synonymPlaceholder')}
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
          />
          <Button type="submit" variant="outline" disabled={add.isPending || !phrase.trim()}>
            {t('semantic.add')}
          </Button>
        </form>
      )}
      {(add.isError || remove.isError) && (
        <Alert variant="destructive">{errorMessage(t, add.error ?? remove.error)}</Alert>
      )}
    </section>
  );
}
