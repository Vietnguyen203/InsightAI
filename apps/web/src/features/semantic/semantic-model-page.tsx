import { Permission, type SemanticModelDetail } from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Rocket } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { orgKey, useActiveOrganization, usePermission } from '../organizations/use-organization';
import { AccessTab } from './access-tab';
import { KpiTab } from './kpi-tab';
import { MetricsTab } from './metrics-tab';
import { ModelTab } from './model-tab';
import { QueryTab } from './query-tab';
import { semanticApi } from './semantic-api';
import { ModelStatusBadge, ValidationBadge } from './semantic-list-page';

const TABS = ['model', 'metrics', 'query', 'kpi', 'access'] as const;
type Tab = (typeof TABS)[number];

export function SemanticModelPage() {
  const { t, i18n } = useTranslation();
  const { modelId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const canWrite = usePermission(Permission.SEMANTIC_WRITE);
  const canPublish = usePermission(Permission.SEMANTIC_PUBLISH);
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'model';
  const key = orgKey(organizationId, 'semantic-model', modelId);

  const model = useQuery({ queryKey: key, queryFn: () => semanticApi.model(modelId) });
  const update = (detail: SemanticModelDetail) => {
    queryClient.setQueryData(key, detail);
    void queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'semantic-models') });
  };
  const validate = useMutation({
    mutationFn: () => semanticApi.validate(modelId),
    onSuccess: update,
  });
  const publish = useMutation({
    mutationFn: () => semanticApi.publish(modelId),
    onSuccess: update,
    // A refused publish still stored its validation report.
    onError: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  if (model.isError) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <Link to="/semantic" className="text-muted-foreground text-sm hover:underline">
          {t('semantic.back')}
        </Link>
        <Alert variant="destructive">{errorMessage(t, model.error)}</Alert>
      </div>
    );
  }
  if (!model.data) return <p className="text-muted-foreground text-sm">{t('common.loading')}</p>;
  const data = model.data;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="space-y-2">
        <Link to="/semantic" className="text-muted-foreground text-sm hover:underline">
          {t('semantic.back')}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{data.name}</h1>
            <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono">{data.key}</span>
              <ModelStatusBadge status={data.status} revision={data.revision} />
              <ValidationBadge status={data.validationStatus} />
              {data.hasDraftChanges && data.status === 'PUBLISHED' && (
                <Badge variant="outline">{t('semantic.draftChanges')}</Badge>
              )}
              {data.publishedAt && (
                <span>
                  {t('semantic.publishedAt', {
                    date: formatDateTime(data.publishedAt, i18n.language),
                  })}
                </span>
              )}
            </div>
            {data.description && (
              <p className="text-muted-foreground text-sm">{data.description}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {canWrite && (
              <Button
                variant="outline"
                onClick={() => validate.mutate()}
                disabled={validate.isPending}
              >
                <CheckCircle2 />
                {validate.isPending ? t('semantic.validating') : t('semantic.validate')}
              </Button>
            )}
            {canPublish && (
              <Button
                onClick={() => publish.mutate()}
                disabled={
                  publish.isPending || (!data.hasDraftChanges && data.status === 'PUBLISHED')
                }
              >
                <Rocket />
                {t('semantic.publish')}
              </Button>
            )}
          </div>
        </div>
        {validate.isError && <Alert variant="destructive">{errorMessage(t, validate.error)}</Alert>}
        {publish.isError && (
          <Alert variant="destructive">
            {publish.error instanceof ApiError && publish.error.status === 409
              ? t('semantic.publishBlocked')
              : errorMessage(t, publish.error)}
          </Alert>
        )}
        <ValidationReport model={data} />
      </div>

      <div className="space-y-4">
        <div role="tablist" aria-label={data.name} className="flex gap-1 overflow-x-auto border-b">
          {TABS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setParams({ tab: k }, { replace: true })}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                tab === k
                  ? 'border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground border-transparent',
              )}
            >
              {t(`semantic.tabs.${k}`)}
            </button>
          ))}
        </div>
        <div role="tabpanel">
          {tab === 'model' ? (
            <ModelTab model={data} onChange={update} />
          ) : tab === 'metrics' ? (
            <MetricsTab model={data} />
          ) : data.status !== 'PUBLISHED' && tab !== 'access' ? (
            <p className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
              {t('semantic.publishFirst')}
            </p>
          ) : tab === 'query' ? (
            <QueryTab model={data} />
          ) : tab === 'kpi' ? (
            <KpiTab model={data} />
          ) : (
            <AccessTab model={data} />
          )}
        </div>
      </div>
    </div>
  );
}

function ValidationReport({ model }: { model: SemanticModelDetail }) {
  const { t, i18n } = useTranslation();
  const report = model.validationReport;
  if (!report || report.issues.length === 0) {
    return report ? (
      <Alert variant="success">
        {t('semantic.reportClean', { date: formatDateTime(report.checkedAt, i18n.language) })}
      </Alert>
    ) : null;
  }
  const hasErrors = report.issues.some((i) => i.severity === 'error');
  return (
    <Alert variant={hasErrors ? 'destructive' : 'default'} className="space-y-2">
      <p className="font-medium">
        {hasErrors ? t('semantic.reportErrors') : t('semantic.reportWarnings')}
      </p>
      <ul className="space-y-1 text-sm">
        {report.issues.map((issue, index) => (
          <li key={index} className="flex flex-wrap items-baseline gap-2">
            <Badge
              variant={issue.severity === 'error' ? 'destructive' : 'outline'}
              className={cn(issue.severity === 'warning' && 'border-warning/40 text-warning')}
            >
              {t(`semantic.severity.${issue.severity}`)}
            </Badge>
            {issue.path && !issue.path.startsWith('relationship:') && (
              <span className="font-mono text-xs">{issue.path}</span>
            )}
            <span className="text-foreground">
              {t(`semantic.issue.${issue.code}`, { defaultValue: issue.message })}
            </span>
          </li>
        ))}
      </ul>
    </Alert>
  );
}
