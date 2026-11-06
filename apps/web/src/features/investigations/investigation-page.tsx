import type { InvestigationDetail, StepStatus } from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  Loader2,
  MinusCircle,
  Play,
  Printer,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import { orgKey, useActiveOrganization } from '../organizations/use-organization';
import { PageHeader, Section } from '../settings/page-header';
import { EvidencePanel } from './evidence-panel';
import { StatusBadge } from './investigation-list-page';
import { hasReport, investigationsApi, isTerminal } from './investigations-api';
import { ReportView } from './report-view';

/** One investigation: live progress, the plan, then the report with its evidence. */
export function InvestigationPage() {
  const { investigationId = '' } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const key = orgKey(organizationId, 'investigation', investigationId);
  const [streamEnded, setStreamEnded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const evidenceRef = useRef<HTMLDivElement>(null);

  const detail = useQuery({
    queryKey: key,
    queryFn: () => investigationsApi.get(investigationId),
    // Polling only when the live stream is not available.
    refetchInterval: (query) =>
      streamEnded && query.state.data && !isTerminal(query.state.data.status) ? 3000 : false,
  });
  const status = detail.data?.status;
  const running = status !== undefined && !isTerminal(status);
  const finished = status !== undefined && hasReport(status);

  const report = useQuery({
    queryKey: orgKey(organizationId, 'investigation-report', investigationId),
    queryFn: () => investigationsApi.report(investigationId),
    enabled: finished,
  });
  const evidence = useQuery({
    queryKey: orgKey(organizationId, 'investigation-evidence', investigationId),
    queryFn: () => investigationsApi.evidence(investigationId),
    enabled: finished,
  });

  // Live progress: every event refreshes the detail (the events carry no data values).
  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    const refresh = () => void queryClient.invalidateQueries({ queryKey: key });
    investigationsApi
      .events(
        investigationId,
        (event) => {
          refresh();
          if (event.type === 'done') {
            void queryClient.invalidateQueries({
              queryKey: orgKey(organizationId, 'investigations'),
            });
          }
        },
        { signal: controller.signal },
      )
      .catch(() => undefined)
      .finally(() => {
        if (controller.signal.aborted) return;
        refresh();
        setStreamEnded(true);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect only when running changes
  }, [running, investigationId, organizationId]);

  const update = (data: InvestigationDetail) => queryClient.setQueryData(key, data);
  const approve = useMutation({
    mutationFn: () => investigationsApi.approve(investigationId),
    onSuccess: update,
  });
  const cancel = useMutation({
    mutationFn: () => investigationsApi.cancel(investigationId),
    onSuccess: update,
  });
  const remove = useMutation({
    mutationFn: () => investigationsApi.remove(investigationId),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'investigations') });
      void navigate('/investigations');
    },
  });

  const showEvidence = (evidenceId: string) => {
    setSelected(evidenceId);
    requestAnimationFrame(() => evidenceRef.current?.scrollIntoView?.({ behavior: 'smooth' }));
  };

  if (detail.isPending)
    return <p className="text-muted-foreground text-sm">{t('common.loading')}</p>;
  if (detail.isError) {
    return <Alert variant="destructive">{errorMessage(t, detail.error)}</Alert>;
  }
  const inv = detail.data;
  const mutationError = approve.error ?? cancel.error ?? remove.error;
  const chosen = evidence.data?.find((e) => e.id === selected) ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link
        to="/investigations"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm print:hidden"
      >
        <ArrowLeft className="size-4" />
        {t('investigations.title')}
      </Link>
      <PageHeader
        title={inv.goal}
        description={`${inv.model} · ${formatDateTime(inv.createdAt, i18n.language)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <StatusBadge status={inv.status} />
            {inv.status === 'AWAITING_APPROVAL' && (
              <Button size="sm" onClick={() => approve.mutate()} disabled={approve.isPending}>
                <Play />
                {t('investigations.approve')}
              </Button>
            )}
            {running && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending || inv.cancelRequested}
              >
                <Square />
                {inv.cancelRequested ? t('investigations.cancelling') : t('common.cancel')}
              </Button>
            )}
            {report.data && (
              <Button size="sm" variant="outline" onClick={() => window.print()}>
                <Printer />
                {t('investigations.print')}
              </Button>
            )}
            {!running && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('investigations.delete')}
                onClick={() => {
                  if (window.confirm(t('investigations.confirmDelete'))) remove.mutate();
                }}
                disabled={remove.isPending}
              >
                <Trash2 />
              </Button>
            )}
          </div>
        }
      />
      {mutationError && <Alert variant="destructive">{errorMessage(t, mutationError)}</Alert>}
      {(inv.status === 'FAILED' || inv.status === 'PARTIAL') && inv.errorCode && (
        <Alert variant={inv.status === 'FAILED' ? 'destructive' : 'default'}>
          {t(`investigations.errors.${inv.errorCode}`, {
            defaultValue: t('investigations.errors.other', { code: inv.errorCode }),
          })}
          {inv.errorMessage && inv.errorCode === 'PLAN_NOT_POSSIBLE' && (
            <span className="block text-xs">{inv.errorMessage}</span>
          )}
        </Alert>
      )}
      {inv.status === 'CANCELLED' && <Alert>{t('investigations.cancelled')}</Alert>}

      <div className="print:hidden">
        <Progress inv={inv} />
      </div>

      {finished && report.isPending && (
        <p className="text-muted-foreground text-sm">{t('investigations.report.loading')}</p>
      )}
      {report.isError && <Alert variant="destructive">{errorMessage(t, report.error)}</Alert>}
      {report.data && (
        <ReportView report={report.data} evidence={evidence.data} onEvidence={showEvidence} />
      )}

      <div ref={evidenceRef} className="print:hidden">
        {chosen && (
          <EvidencePanel
            evidence={chosen}
            step={inv.steps.find((s) => s.stepKey === chosen.stepKey)}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

const STEP_ICONS: Record<StepStatus, typeof Circle> = {
  PENDING: Circle,
  RUNNING: Loader2,
  SUCCEEDED: CheckCircle2,
  FAILED: XCircle,
  SKIPPED: MinusCircle,
};
const STEP_COLORS: Record<StepStatus, string> = {
  PENDING: 'text-muted-foreground',
  RUNNING: 'text-primary animate-spin',
  SUCCEEDED: 'text-success',
  FAILED: 'text-destructive',
  SKIPPED: 'text-muted-foreground',
};

/** The plan as steps with their state, the hypotheses and the budget used. */
function Progress({ inv }: { inv: InvestigationDetail }) {
  const { t, i18n } = useTranslation();
  const n = (value: number) => formatNumber(value, i18n.language);
  const waiting = inv.status === 'QUEUED' || inv.status === 'PLANNING';
  return (
    <Section
      title={t('investigations.plan')}
      description={
        waiting ? t('investigations.planning') : t(`investigations.phase.${inv.status}`, '')
      }
    >
      {inv.steps.length > 0 && (
        <ol className="space-y-2" aria-label={t('investigations.steps')}>
          {inv.steps.map((s) => {
            const Icon = STEP_ICONS[s.status];
            return (
              <li key={s.id} className="flex items-start gap-3 text-sm">
                <Icon className={`mt-0.5 size-4 shrink-0 ${STEP_COLORS[s.status]}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p>{s.purpose}</p>
                  <p className="text-muted-foreground text-xs">
                    {t(`investigations.tools.${s.tool}`, { defaultValue: s.tool })} ·{' '}
                    {t(`investigations.stepStatus.${s.status}`)}
                    {s.errorCode &&
                      ` · ${t(`investigations.errors.${s.errorCode}`, { defaultValue: s.errorCode })}`}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {inv.plan && inv.plan.hypotheses.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{t('investigations.hypotheses')}</h3>
          <ul className="text-muted-foreground list-disc pl-5 text-sm">
            {inv.plan.hypotheses.map((h) => (
              <li key={h.id}>{h.statement}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        {t('investigations.usage', {
          steps: n(inv.usage.steps),
          maxSteps: n(inv.budget.maxSteps),
          queries: n(inv.usage.queries),
          maxQueries: n(inv.budget.maxQueries),
          tokens: n(inv.usage.tokens),
        })}
      </p>
    </Section>
  );
}
