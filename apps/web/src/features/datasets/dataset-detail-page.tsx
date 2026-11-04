import { Permission } from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { orgKey, useActiveOrganization, usePermission } from '../organizations/use-organization';
import { DataTab } from './data-tab';
import { datasetsApi, isInProgress } from './datasets-api';
import { ImportsTab } from './imports-tab';
import { ProfileTab } from './profile-tab';
import { SchemaTab } from './schema-tab';
import { DatasetStatusBadge, ImportStatusBadge, ProfileStatusBadge } from './status-badges';
import { CleaningTab } from '../quality/cleaning-tab';
import { QualityStatusBadge } from '../quality/quality-badges';
import { QualityTab } from '../quality/quality-tab';
import { VersionsTab } from '../quality/versions-tab';
import { UploadPanel } from './upload-panel';

const TABS = ['data', 'schema', 'profile', 'quality', 'cleaning', 'versions', 'imports'] as const;
/** A new version is checked right after it is created; poll while that is likely running. */
const RECENT_MS = 5 * 60_000;
type Tab = (typeof TABS)[number];

export function DatasetDetailPage() {
  const { t, i18n } = useTranslation();
  const { datasetId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const canWrite = usePermission(Permission.DATASET_WRITE);

  const [uploadOpen, setUploadOpen] = useState<boolean | null>(null);
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'data';

  const dataset = useQuery({
    queryKey: orgKey(organizationId, 'dataset', datasetId),
    queryFn: () => datasetsApi.get(datasetId),
    refetchInterval: (query) => {
      const data = query.state.data;
      const busy =
        isInProgress(data?.latestImport?.status) ||
        isInProgress(data?.activeVersion?.profileStatus) ||
        (data?.versions ?? []).some(
          (v) =>
            (v.qualityStatus === 'UNCHECKED' || isInProgress(v.profileStatus)) &&
            Date.now() - Date.parse(v.createdAt) < RECENT_MS,
        );
      return busy ? 2000 : false;
    },
  });

  const archive = useMutation({
    mutationFn: () => datasetsApi.archive(datasetId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'datasets') });
      void navigate('/datasets');
    },
  });

  if (dataset.isError) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <Link to="/datasets" className="text-muted-foreground text-sm hover:underline">
          {t('datasets.back')}
        </Link>
        <Alert variant="destructive">{errorMessage(t, dataset.error)}</Alert>
      </div>
    );
  }
  if (!dataset.data) return <p className="text-muted-foreground text-sm">{t('common.loading')}</p>;

  const data = dataset.data;
  const version = data.activeVersion;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="space-y-2">
        <Link to="/datasets" className="text-muted-foreground text-sm hover:underline">
          {t('datasets.back')}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{data.name}</h1>
            {data.description && (
              <p className="text-muted-foreground text-sm">{data.description}</p>
            )}
            <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
              <DatasetStatusBadge status={data.status} />
              {version && (
                <>
                  <span>{t('datasets.versionLabel', { n: version.versionNo })}</span>
                  <span>·</span>
                  <span>
                    {t('datasets.rowsCount', {
                      rows: formatNumber(version.rowCount, i18n.language),
                    })}
                  </span>
                  <span>·</span>
                  <span>{formatDateTime(version.createdAt, i18n.language)}</span>
                  <ProfileStatusBadge status={version.profileStatus} />
                  {version.qualityStatus !== 'UNCHECKED' && (
                    <QualityStatusBadge status={version.qualityStatus} />
                  )}
                </>
              )}
              {data.latestImport && isInProgress(data.latestImport.status) && (
                <ImportStatusBadge status={data.latestImport.status} />
              )}
            </div>
          </div>
          {canWrite && data.status !== 'ARCHIVED' && (
            <Button
              variant="outline"
              disabled={archive.isPending}
              onClick={() => {
                if (window.confirm(t('datasets.archiveConfirm', { name: data.name })))
                  archive.mutate();
              }}
            >
              {t('datasets.archive')}
            </Button>
          )}
        </div>
        {archive.isError && <Alert variant="destructive">{errorMessage(t, archive.error)}</Alert>}
      </div>

      {canWrite &&
        data.status !== 'ARCHIVED' &&
        // Open by default only while the dataset is empty; afterwards behind a button.
        ((uploadOpen ?? !version) ? (
          <div className="space-y-2">
            <UploadPanel datasetId={data.id} />
            {version && (
              <Button variant="ghost" size="sm" onClick={() => setUploadOpen(false)}>
                {t('datasets.collapse')}
              </Button>
            )}
          </div>
        ) : (
          <Button variant="outline" onClick={() => setUploadOpen(true)}>
            <Upload />
            {t('datasets.uploadNew')}
          </Button>
        ))}

      <div className="space-y-4">
        <div role="tablist" aria-label={data.name} className="flex gap-1 overflow-x-auto border-b">
          {TABS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setParams({ tab: key }, { replace: true })}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                tab === key
                  ? 'border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground border-transparent',
              )}
            >
              {t(`datasets.tabs.${key}`)}
            </button>
          ))}
        </div>

        <div role="tabpanel">
          {tab === 'imports' ? (
            <ImportsTab datasetId={data.id} />
          ) : tab === 'versions' && data.versions.length > 0 ? (
            <VersionsTab
              key={params.get('focus') ?? 'versions'}
              datasetId={data.id}
              versions={data.versions}
              activeVersionId={version?.id ?? null}
              focusVersionId={params.get('focus')}
            />
          ) : !version ? (
            <p className="text-muted-foreground text-sm">{t('datasets.noData')}</p>
          ) : tab === 'data' ? (
            <DataTab datasetId={data.id} versionId={version.id} />
          ) : tab === 'schema' ? (
            <SchemaTab columns={data.columns} />
          ) : tab === 'quality' ? (
            <QualityTab datasetId={data.id} activeVersionId={version.id} columns={data.columns} />
          ) : tab === 'cleaning' ? (
            <CleaningTab
              key={version.id}
              datasetId={data.id}
              versions={data.versions}
              activeVersionId={version.id}
              onOpenVersions={(versionId) =>
                setParams({ tab: 'versions', focus: versionId }, { replace: true })
              }
            />
          ) : (
            <ProfileTab datasetId={data.id} versionId={version.id} />
          )}
        </div>
      </div>
    </div>
  );
}
