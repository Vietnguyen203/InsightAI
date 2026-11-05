import { type CreateWidgetRequest, Permission } from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pin } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { errorMessage } from '@/lib/errors';
import { orgKey, useActiveOrganization, usePermission } from '../organizations/use-organization';
import { dashboardApi } from './dashboard-api';

const NEW = '__new__';

/**
 * "Pin to dashboard": adds the given query (or AI answer) as a widget to a dashboard the user
 * may edit, or to a new private one. Hidden for roles without `dashboard:write`.
 */
export function PinToDashboard({ widget }: { widget: CreateWidgetRequest }) {
  const { t } = useTranslation();
  const canWrite = usePermission(Permission.DASHBOARD_WRITE);
  const [open, setOpen] = useState(false);
  if (!canWrite) return null;
  return open ? (
    <PinForm widget={widget} onClose={() => setOpen(false)} />
  ) : (
    <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
      <Pin />
      {t('dashboards.pin')}
    </Button>
  );
}

function PinForm({ widget, onClose }: { widget: CreateWidgetRequest; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const dashboards = useQuery({
    queryKey: orgKey(organizationId, 'dashboards'),
    queryFn: dashboardApi.list,
  });
  const editable = (dashboards.data ?? []).filter((d) => d.canEdit);
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const chosen = target || editable[0]?.id || NEW;

  const pin = useMutation({
    mutationFn: async () => {
      const id =
        chosen === NEW
          ? (await dashboardApi.create({ name: name.trim(), visibility: 'PRIVATE' })).id
          : chosen;
      return dashboardApi.addWidget(id, widget);
    },
    onSuccess: async (dashboard) => {
      queryClient.setQueryData(orgKey(organizationId, 'dashboard', dashboard.id), dashboard);
      await queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'dashboards') });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (chosen === NEW && !name.trim()) return;
    pin.mutate();
  };

  if (pin.data) {
    return (
      <p className="text-success flex flex-wrap items-center gap-2 text-sm" role="status">
        {t('dashboards.pinned')}
        <Link className="text-primary underline" to={`/dashboards/${pin.data.id}`}>
          {pin.data.name}
        </Link>
      </p>
    );
  }
  return (
    <form
      className="bg-muted/40 flex flex-wrap items-end gap-2 rounded-lg border p-2"
      onSubmit={submit}
      aria-label={t('dashboards.pin')}
    >
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">{t('dashboards.pinTarget')}</span>
        <NativeSelect
          className="h-8 w-56 max-w-full"
          value={chosen}
          onChange={(e) => setTarget(e.target.value)}
          disabled={dashboards.isPending}
        >
          {editable.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
          <option value={NEW}>{t('dashboards.pinNew')}</option>
        </NativeSelect>
      </label>
      {chosen === NEW && (
        <label className="grid gap-1 text-xs">
          <span className="text-muted-foreground">{t('dashboards.name')}</span>
          <Input
            className="h-8 w-56 max-w-full"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      )}
      <Button type="submit" size="sm" disabled={pin.isPending || (chosen === NEW && !name.trim())}>
        {t('dashboards.pinConfirm')}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onClose}>
        {t('common.cancel')}
      </Button>
      {pin.isError && (
        <p className="text-destructive w-full text-xs">{errorMessage(t, pin.error)}</p>
      )}
    </form>
  );
}
