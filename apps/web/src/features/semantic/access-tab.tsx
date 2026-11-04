import {
  type AccessPolicy,
  createAccessPolicyRequestSchema,
  Permission,
  type SemanticModelDetail,
} from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { errorMessage } from '@/lib/errors';
import { orgKey, useActiveOrganization, usePermission } from '../organizations/use-organization';
import { semanticApi } from './semantic-api';

const ROLES = ['owner', 'admin', 'analyst', 'viewer'] as const;
const splitList = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);

/** Role-based access policies: hidden members and row filters (take effect immediately). */
export function AccessTab({ model }: { model: SemanticModelDetail }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const canManage = usePermission(Permission.SEMANTIC_PUBLISH);
  const key = orgKey(organizationId, 'semantic-model', model.id, 'policies');
  const [adding, setAdding] = useState(false);
  const policies = useQuery({ queryKey: key, queryFn: () => semanticApi.policies(model.id) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const change = useMutation({
    mutationFn: async (action: { policy: AccessPolicy; remove?: boolean }): Promise<void> => {
      if (action.remove) await semanticApi.deletePolicy(action.policy.id);
      else await semanticApi.updatePolicy(action.policy.id, { enabled: !action.policy.enabled });
    },
    onSuccess: refresh,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-muted-foreground max-w-2xl text-sm">{t('semantic.accessHint')}</p>
        {canManage && !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus />
            {t('semantic.addPolicy')}
          </Button>
        )}
      </div>
      {adding && (
        <PolicyForm
          model={model}
          onCancel={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void refresh();
          }}
        />
      )}
      {change.isError && <Alert variant="destructive">{errorMessage(t, change.error)}</Alert>}
      {policies.isError ? (
        <Alert variant="destructive">{errorMessage(t, policies.error)}</Alert>
      ) : !policies.data ? (
        <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
      ) : policies.data.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
          {t('semantic.noPolicies')}
        </p>
      ) : (
        <ul className="space-y-3">
          {policies.data.map((p) => (
            <li key={p.id} className="bg-card space-y-2 rounded-xl border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.name}</span>
                {p.roles.map((r) => (
                  <Badge key={r} variant="secondary">
                    {t(`roles.${r}`)}
                  </Badge>
                ))}
                {!p.enabled && <Badge variant="outline">{t('semantic.disabled')}</Badge>}
                {canManage && (
                  <div className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => change.mutate({ policy: p })}>
                      {p.enabled ? t('semantic.disable') : t('semantic.enable')}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-destructive size-8"
                      aria-label={t('semantic.deletePolicy', { name: p.name })}
                      onClick={() => {
                        if (window.confirm(t('semantic.deletePolicyConfirm', { name: p.name }))) {
                          change.mutate({ policy: p, remove: true });
                        }
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </div>
              <dl className="text-muted-foreground grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
                {p.memberAccess?.include && (
                  <>
                    <dt>{t('semantic.include')}</dt>
                    <dd className="font-mono text-xs">{p.memberAccess.include.join(', ')}</dd>
                  </>
                )}
                {p.memberAccess?.exclude && (
                  <>
                    <dt>{t('semantic.exclude')}</dt>
                    <dd className="font-mono text-xs">{p.memberAccess.exclude.join(', ')}</dd>
                  </>
                )}
                <dt>{t('semantic.rowFilter')}</dt>
                <dd className="font-mono text-xs">
                  {p.rowFilter
                    ? `${p.rowFilter.entity}: ${p.rowFilter.expr}`
                    : t('semantic.allRows')}
                </dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PolicyForm({
  model,
  onCancel,
  onDone,
}: {
  model: SemanticModelDetail;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<string[]>(['viewer']);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [entity, setEntity] = useState('');
  const [expr, setExpr] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Parameters<typeof semanticApi.createPolicy>[1]) =>
      semanticApi.createPolicy(model.id, body),
    onSuccess: onDone,
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const inc = splitList(include);
    const exc = splitList(exclude);
    const body = {
      name,
      roles,
      memberAccess:
        inc.length || exc.length
          ? { ...(inc.length ? { include: inc } : {}), ...(exc.length ? { exclude: exc } : {}) }
          : null,
      rowFilter: entity && expr.trim() ? { entity, expr } : null,
    };
    const parsed = createAccessPolicyRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setFormError(issue ? `${issue.path.join('.')}: ${issue.message}` : null);
      return;
    }
    setFormError(null);
    save.mutate(body as Parameters<typeof semanticApi.createPolicy>[1]);
  };

  return (
    <form
      onSubmit={submit}
      className="bg-card space-y-4 rounded-xl border p-4"
      aria-label={t('semantic.addPolicy')}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('semantic.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">{t('semantic.roles')}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {ROLES.map((r) => (
              <label key={r} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={roles.includes(r)}
                  onChange={(e) =>
                    setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))
                  }
                />
                {t(`roles.${r}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label={t('semantic.include')} hint={t('semantic.patternHint')}>
          <Input
            className="font-mono"
            value={include}
            onChange={(e) => setInclude(e.target.value)}
            placeholder="metric:*, order.*"
          />
        </Field>
        <Field label={t('semantic.exclude')} hint={t('semantic.patternHint')}>
          <Input
            className="font-mono"
            value={exclude}
            onChange={(e) => setExclude(e.target.value)}
            placeholder="metric:margin"
          />
        </Field>
        <Field label={t('semantic.rowFilterEntity')}>
          <NativeSelect value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">{t('semantic.allRows')}</option>
            {model.entities.map((e) => (
              <option key={e.id} value={e.key}>
                {e.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t('semantic.rowFilterExpr')} hint={t('semantic.rowFilterHint')}>
          <Input
            className="font-mono"
            value={expr}
            disabled={!entity}
            onChange={(e) => setExpr(e.target.value)}
            placeholder="region = 'North'"
          />
        </Field>
      </div>
      {(formError || save.isError) && (
        <Alert variant="destructive">{formError ?? errorMessage(t, save.error)}</Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={save.isPending || !name.trim() || roles.length === 0}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
