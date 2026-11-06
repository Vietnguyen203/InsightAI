import { type InvestigationStatus, Permission } from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/input';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { askApi } from '../ask/ask-api';
import { orgKey, useActiveOrganization, usePermission } from '../organizations/use-organization';
import { semanticApi } from '../semantic/semantic-api';
import { PageHeader, Section } from '../settings/page-header';
import { investigationsApi, isTerminal } from './investigations-api';

export function InvestigationListPage() {
  const { t, i18n } = useTranslation();
  const { organizationId } = useActiveOrganization();
  const canQuery = usePermission(Permission.SEMANTIC_QUERY);
  const investigations = useQuery({
    queryKey: orgKey(organizationId, 'investigations'),
    queryFn: investigationsApi.list,
    enabled: canQuery,
    // Keeps the statuses of running investigations fresh on the list.
    refetchInterval: (query) =>
      query.state.data?.some((i) => !isTerminal(i.status)) ? 5000 : false,
  });

  if (!canQuery) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader title={t('investigations.title')} />
        <Alert>{t('investigations.noPermission')}</Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('investigations.title')} description={t('investigations.description')} />
      <CreateInvestigationForm />

      <Section title={t('investigations.history')}>
        {investigations.isError && (
          <Alert variant="destructive">{errorMessage(t, investigations.error)}</Alert>
        )}
        {investigations.isPending && (
          <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
        )}
        {investigations.data?.length === 0 && (
          <p className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
            {t('investigations.empty')}
          </p>
        )}
        {investigations.data && investigations.data.length > 0 && (
          <ul className="divide-y">
            {investigations.data.map((i) => (
              <li key={i.id}>
                <Link
                  to={`/investigations/${i.id}`}
                  className="hover:bg-muted/50 flex flex-wrap items-center gap-3 rounded-md px-2 py-3"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{i.goal}</span>
                  <StatusBadge status={i.status} />
                  <span className="text-muted-foreground text-xs">
                    {formatDateTime(i.createdAt, i18n.language)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

export function StatusBadge({ status }: { status: InvestigationStatus }) {
  const { t } = useTranslation();
  const variant =
    status === 'COMPLETED'
      ? 'success'
      : status === 'FAILED'
        ? 'destructive'
        : status === 'PARTIAL' || status === 'CANCELLED'
          ? 'outline'
          : 'secondary';
  return (
    <Badge variant={variant} className="shrink-0">
      {t(`investigations.status.${status}`)}
    </Badge>
  );
}

function CreateInvestigationForm() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const status = useQuery({
    queryKey: orgKey(organizationId, 'ai-status'),
    queryFn: askApi.status,
  });
  const models = useQuery({
    queryKey: orgKey(organizationId, 'semantic-models'),
    queryFn: semanticApi.models,
  });
  const published = (models.data ?? []).filter((m) => m.publishedAt !== null);
  const [model, setModel] = useState('');
  const [goal, setGoal] = useState('');
  const [requireApproval, setRequireApproval] = useState(false);
  const chosen = model || published[0]?.key || '';

  const create = useMutation({
    mutationFn: investigationsApi.create,
    onSuccess: async (created) => {
      queryClient.setQueryData(orgKey(organizationId, 'investigation', created.id), created);
      await queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'investigations') });
      void navigate(`/investigations/${created.id}`);
    },
  });
  const disabled = status.data?.enabled === false || published.length === 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (goal.trim().length >= 5 && chosen) {
      create.mutate({ model: chosen, goal: goal.trim(), requireApproval });
    }
  };

  return (
    <Section title={t('investigations.create')} description={t('investigations.createHint')}>
      {status.data?.enabled === false && <Alert>{t('investigations.aiDisabled')}</Alert>}
      {models.isSuccess && published.length === 0 && (
        <Alert>
          {t('investigations.noModel')}{' '}
          <Link className="text-primary underline" to="/semantic">
            {t('nav.semantic')}
          </Link>
        </Alert>
      )}
      <form className="grid gap-4" noValidate onSubmit={submit}>
        <div className="grid gap-4 md:grid-cols-[1fr_3fr]">
          <Field label={t('investigations.model')}>
            <NativeSelect
              value={chosen}
              onChange={(e) => setModel(e.target.value)}
              disabled={disabled}
            >
              {published.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('investigations.goal')} hint={t('investigations.goalHint')}>
            <textarea
              className="border-input bg-background min-h-20 rounded-md border px-3 py-2 text-sm"
              maxLength={1000}
              value={goal}
              disabled={disabled}
              placeholder={t('investigations.goalPlaceholder')}
              onChange={(e) => setGoal(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={requireApproval}
              disabled={disabled}
              onChange={(e) => setRequireApproval(e.target.checked)}
            />
            {t('investigations.requireApproval')}
          </label>
          <Button type="submit" disabled={disabled || goal.trim().length < 5 || create.isPending}>
            <Search />
            {create.isPending ? t('investigations.starting') : t('investigations.start')}
          </Button>
        </div>
      </form>
      {create.isError && <Alert variant="destructive">{errorMessage(t, create.error)}</Alert>}
    </Section>
  );
}
