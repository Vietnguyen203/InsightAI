import type { DashboardDetail, DashboardVisibility, WidgetPosition } from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, LayoutGrid, Pencil, Trash2, X } from 'lucide-react';
import { type CSSProperties, type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { errorMessage } from '@/lib/errors';
import { useMe } from '../auth/use-session';
import { orgKey, useActiveOrganization } from '../organizations/use-organization';
import { dashboardApi } from './dashboard-api';
import { VisibilityBadge } from './dashboard-list-page';
import { applyMove, byPosition, type Move } from './layout';
import { WidgetCard } from './widget-card';

/** Height of one grid row on large screens. */
const ROW_PX = 72;

export function DashboardPage() {
  const { t } = useTranslation();
  const { dashboardId } = useParams();
  const { organizationId } = useActiveOrganization();
  const dashboard = useQuery({
    queryKey: orgKey(organizationId, 'dashboard', dashboardId),
    queryFn: () => dashboardApi.get(dashboardId!),
    enabled: dashboardId !== undefined,
    retry: false,
  });

  if (dashboard.isError) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <BackLink />
        <Alert variant="destructive">{errorMessage(t, dashboard.error)}</Alert>
      </div>
    );
  }
  if (!dashboard.data)
    return <p className="text-muted-foreground text-sm">{t('common.loading')}</p>;
  return <DashboardView dashboard={dashboard.data} />;
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <Link
      to="/dashboards"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
    >
      <ArrowLeft className="size-4" />
      {t('dashboards.title')}
    </Link>
  );
}

function DashboardView({ dashboard }: { dashboard: DashboardDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const { data: me } = useMe();
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const isOwner = me?.user.id === dashboard.ownerId;
  const key = orgKey(organizationId, 'dashboard', dashboard.id);

  const saved = (next: DashboardDetail) => {
    queryClient.setQueryData(key, next);
    void queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'dashboards') });
  };
  const update = useMutation({
    mutationFn: (body: { name?: string; visibility?: DashboardVisibility }) =>
      dashboardApi.update(dashboard.id, body),
    onSuccess: (next) => {
      saved(next);
      setRenaming(false);
    },
  });
  const layout = useMutation({
    mutationFn: (widgets: { id: string; position: WidgetPosition }[]) =>
      dashboardApi.layout(dashboard.id, { widgets }),
    onSuccess: saved,
  });
  const removeWidget = useMutation({
    mutationFn: dashboardApi.removeWidget,
    onSuccess: saved,
  });
  const remove = useMutation({
    mutationFn: () => dashboardApi.remove(dashboard.id),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'dashboards') });
      void navigate('/dashboards');
    },
  });

  const move = (id: string, m: Move) => {
    const positions = new Map(dashboard.widgets.map((w) => [w.id, w.position]));
    const next = applyMove(positions, id, m);
    if (next) layout.mutate([{ id, position: next }]);
  };
  const widgets = [...dashboard.widgets].sort(byPosition);
  const failure = update.error ?? layout.error ?? removeWidget.error ?? remove.error;

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {renaming ? (
            <RenameForm
              name={dashboard.name}
              pending={update.isPending}
              onSave={(name) => update.mutate({ name })}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <h1 className="flex min-w-0 items-center gap-2 text-2xl font-semibold tracking-tight">
              <span className="truncate">{dashboard.name}</span>
              {dashboard.canEdit && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  aria-label={t('dashboards.rename')}
                  onClick={() => setRenaming(true)}
                >
                  <Pencil className="size-4" />
                </Button>
              )}
            </h1>
          )}
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <VisibilityBadge visibility={dashboard.visibility} />
            {dashboard.ownerName && (
              <span>{t('dashboards.owner', { name: dashboard.ownerName })}</span>
            )}
            {!dashboard.canEdit && <span>· {t('dashboards.readOnly')}</span>}
          </div>
        </div>
        {dashboard.canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            {isOwner && (
              <NativeSelect
                aria-label={t('dashboards.visibilityLabel')}
                className="h-9 w-auto"
                value={dashboard.visibility}
                disabled={update.isPending}
                onChange={(e) =>
                  update.mutate({ visibility: e.target.value as DashboardVisibility })
                }
              >
                <option value="PRIVATE">{t('dashboards.visibility.PRIVATE')}</option>
                <option value="ORG">{t('dashboards.visibility.ORG')}</option>
              </NativeSelect>
            )}
            <Button
              variant={editing ? 'default' : 'outline'}
              onClick={() => setEditing((v) => !v)}
              disabled={dashboard.widgets.length === 0}
            >
              {editing ? <Check /> : <LayoutGrid />}
              {editing ? t('dashboards.doneEditing') : t('dashboards.editLayout')}
            </Button>
            <Button
              variant="ghost"
              className="text-destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(t('dashboards.deleteConfirm', { name: dashboard.name }))) {
                  remove.mutate();
                }
              }}
            >
              <Trash2 />
              {t('common.remove')}
            </Button>
          </div>
        )}
      </div>

      {failure && <Alert variant="destructive">{errorMessage(t, failure)}</Alert>}

      {widgets.length === 0 ? (
        <div className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
          {dashboard.canEdit ? t('dashboards.noWidgets') : t('dashboards.noWidgetsReadOnly')}
        </div>
      ) : (
        <ol
          className="grid grid-cols-1 gap-4 lg:auto-rows-[var(--row)] lg:grid-cols-12"
          style={{ '--row': `${ROW_PX}px` } as CSSProperties}
          aria-label={t('dashboards.widgets')}
        >
          {widgets.map((w) => (
            <li
              key={w.id}
              className="min-h-56 lg:min-h-0 lg:[grid-column:var(--col)] lg:[grid-row:var(--grow)]"
              style={
                {
                  '--col': `${w.position.x + 1} / span ${w.position.w}`,
                  '--grow': `${w.position.y + 1} / span ${w.position.h}`,
                } as CSSProperties
              }
            >
              <WidgetCard
                widget={w}
                editing={editing}
                busy={layout.isPending || removeWidget.isPending}
                onMove={(m) => move(w.id, m)}
                onRemove={() => {
                  if (window.confirm(t('dashboards.removeWidgetConfirm', { title: w.title }))) {
                    removeWidget.mutate(w.id);
                  }
                }}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function RenameForm({
  name,
  pending,
  onSave,
  onCancel,
}: {
  name: string;
  pending: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(name);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onSave(value.trim());
  };
  return (
    <form className="flex items-center gap-2" onSubmit={submit}>
      <Input
        aria-label={t('dashboards.name')}
        autoFocus
        maxLength={120}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-9 w-72 max-w-full"
      />
      <Button type="submit" size="icon" aria-label={t('common.save')} disabled={pending}>
        <Check />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={t('common.cancel')}
        onClick={onCancel}
      >
        <X />
      </Button>
    </form>
  );
}
