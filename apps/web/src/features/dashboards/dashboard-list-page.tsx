import { type DashboardVisibility, Permission } from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Lock, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { orgKey, useActiveOrganization, usePermission } from '../organizations/use-organization';
import { PageHeader, Section } from '../settings/page-header';
import { dashboardApi } from './dashboard-api';

export function DashboardListPage() {
  const { t, i18n } = useTranslation();
  const { organizationId } = useActiveOrganization();
  const canWrite = usePermission(Permission.DASHBOARD_WRITE);
  const [creating, setCreating] = useState(false);
  const dashboards = useQuery({
    queryKey: orgKey(organizationId, 'dashboards'),
    queryFn: dashboardApi.list,
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={t('dashboards.title')}
        description={t('dashboards.description')}
        actions={
          canWrite && !creating ? (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              {t('dashboards.create')}
            </Button>
          ) : undefined
        }
      />
      {creating && <CreateDashboardForm onCancel={() => setCreating(false)} />}

      {dashboards.isError && (
        <Alert variant="destructive">{errorMessage(t, dashboards.error)}</Alert>
      )}
      {dashboards.isPending && (
        <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
      )}
      {dashboards.data?.length === 0 && (
        <p className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
          {canWrite ? t('dashboards.empty') : t('dashboards.emptyReadOnly')}
        </p>
      )}
      {dashboards.data && dashboards.data.length > 0 && (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {dashboards.data.map((d) => (
            <li key={d.id}>
              <Link
                to={`/dashboards/${d.id}`}
                className="bg-card hover:border-primary/50 flex h-full flex-col gap-3 rounded-xl border p-5 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="min-w-0 truncate font-semibold">{d.name}</h2>
                  <VisibilityBadge visibility={d.visibility} />
                </div>
                {d.description && (
                  <p className="text-muted-foreground line-clamp-2 text-sm">{d.description}</p>
                )}
                <div className="text-muted-foreground mt-auto flex flex-wrap items-center gap-2 text-xs">
                  <span>{t('dashboards.widgetCount', { count: d.widgetCount })}</span>
                  {d.ownerName && (
                    <>
                      <span>·</span>
                      <span>{d.ownerName}</span>
                    </>
                  )}
                  <span className="ml-auto">{formatDateTime(d.updatedAt, i18n.language)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function VisibilityBadge({ visibility }: { visibility: DashboardVisibility }) {
  const { t } = useTranslation();
  return (
    <Badge variant={visibility === 'ORG' ? 'success' : 'secondary'} className="shrink-0 gap-1">
      {visibility === 'ORG' ? <Globe className="size-3" /> : <Lock className="size-3" />}
      {t(`dashboards.visibility.${visibility}`)}
    </Badge>
  );
}

function CreateDashboardForm({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<DashboardVisibility>('PRIVATE');
  const create = useMutation({
    mutationFn: dashboardApi.create,
    onSuccess: async (dashboard) => {
      await queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'dashboards') });
      void navigate(`/dashboards/${dashboard.id}`);
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate({ name: name.trim(), visibility });
  };

  return (
    <Section title={t('dashboards.create')}>
      <form className="grid gap-4 md:grid-cols-[2fr_1fr_auto]" noValidate onSubmit={onSubmit}>
        <Field label={t('dashboards.name')}>
          <Input autoFocus maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('dashboards.visibilityLabel')}>
          <NativeSelect
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as DashboardVisibility)}
          >
            <option value="PRIVATE">{t('dashboards.visibility.PRIVATE')}</option>
            <option value="ORG">{t('dashboards.visibility.ORG')}</option>
          </NativeSelect>
        </Field>
        <div className="flex items-end gap-2">
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            {t('dashboards.create')}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
      {create.isError && <Alert variant="destructive">{errorMessage(t, create.error)}</Alert>}
    </Section>
  );
}
