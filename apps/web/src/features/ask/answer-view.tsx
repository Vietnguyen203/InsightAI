import { type Answer, Permission } from '@insightai/contracts';
import { useMutation } from '@tanstack/react-query';
import { ChevronDown, Code2, Info, Table2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/errors';
import { usePermission } from '../organizations/use-organization';
import { ResultTable, SqlView } from '../semantic/query-tab';
import { rejectionReason, semanticApi } from '../semantic/semantic-api';
import { PinToDashboard } from '../dashboards/pin-to-dashboard';
import { AnswerChart } from './answer-chart';

/** One assistant answer: narrative, chart, data, how the question was understood, sources. */
export function AnswerView({
  answer,
  onPick,
  disabled,
  messageId,
}: {
  answer: Answer;
  /** Saved message id: answers can be pinned to a dashboard once saved. */
  messageId?: string;
  /** Sends a clarification option or a suggestion as the next question. */
  onPick: (text: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();

  if (answer.status === 'CLARIFICATION' && answer.clarification) {
    return (
      <div className="space-y-3">
        <p>{answer.clarification.question}</p>
        {answer.clarification.options.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {answer.clarification.options.map((option) => (
              <Button
                key={option}
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => onPick(option)}
              >
                {option}
              </Button>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (answer.status === 'CHAT') {
    const suggestions = answer.suggestions ?? [];
    return (
      <div className="space-y-3">
        <p className="whitespace-pre-line">{answer.narrative}</p>
        {suggestions.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-xs">{t('ask.suggestions')}</p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((suggestion) => (
                <Button
                  key={suggestion}
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() => onPick(suggestion)}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }
  if (answer.status === 'CANNOT_ANSWER') {
    return (
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs font-medium uppercase">
          {t('ask.cannotAnswer')}
        </p>
        <p>{answer.narrative}</p>
      </div>
    );
  }
  if (answer.status === 'ERROR' || !answer.result) {
    return <p className="text-destructive">{t('ask.failed')}</p>;
  }
  return <Answered answer={answer} messageId={messageId} />;
}

function Answered({ answer, messageId }: { answer: Answer; messageId?: string }) {
  const { t } = useTranslation();
  const canSeeSql = usePermission(Permission.SEMANTIC_WRITE);
  const [open, setOpen] = useState<'table' | 'sources' | 'sql' | null>(
    answer.chart?.type === 'table' ? 'table' : null,
  );
  const compile = useMutation({ mutationFn: () => semanticApi.compile(answer.query!) });
  const result = answer.result!;
  const provenance = answer.provenance;
  const toggle = (panel: 'table' | 'sources' | 'sql') => {
    setOpen((current) => (current === panel ? null : panel));
    if (panel === 'sql' && !compile.data && !compile.isPending) compile.mutate();
  };

  return (
    <div className="space-y-3">
      <p className="leading-relaxed">{answer.narrative}</p>
      {provenance && (
        <p className="text-muted-foreground text-xs">
          <span className="font-medium">{t('ask.interpretedAs')}</span> {provenance.interpretedAs}
        </p>
      )}
      {answer.chart && <AnswerChart spec={answer.chart} result={result} />}

      <div className="flex flex-wrap gap-2">
        <PanelButton
          active={open === 'table'}
          onClick={() => toggle('table')}
          icon={<Table2 />}
          label={t('ask.showTable', { count: result.rows.length })}
        />
        {provenance && (
          <PanelButton
            active={open === 'sources'}
            onClick={() => toggle('sources')}
            icon={<Info />}
            label={t('ask.showSources')}
          />
        )}
        {canSeeSql && answer.query && (
          <PanelButton
            active={open === 'sql'}
            onClick={() => toggle('sql')}
            icon={<Code2 />}
            label={t('semantic.showSql')}
          />
        )}
      </div>

      {messageId && <PinToDashboard widget={{ fromMessageId: messageId }} />}
      {open === 'table' && <ResultTable result={result} />}
      {open === 'sources' && provenance && (
        <dl className="bg-muted/40 grid gap-x-4 gap-y-2 rounded-lg border p-3 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{t('ask.metrics')}</dt>
          <dd className="flex flex-wrap gap-1">
            {provenance.metrics.map((m) => (
              <Badge key={m.key} variant="outline">
                {m.label} · v{m.version}
              </Badge>
            ))}
          </dd>
          <dt className="text-muted-foreground">{t('ask.datasets')}</dt>
          <dd className="space-y-0.5">
            {provenance.datasets.length === 0 && '—'}
            {provenance.datasets.map((d) => (
              <p key={d.id}>
                {d.name} · v{d.versionNo}
                {d.qualityScore !== null && (
                  <span className="text-muted-foreground">
                    {' '}
                    · {t('ask.quality', { score: Math.round(d.qualityScore) })}
                  </span>
                )}
              </p>
            ))}
          </dd>
          <dt className="text-muted-foreground">{t('ask.modelRevision')}</dt>
          <dd>r{provenance.modelRevision}</dd>
          {provenance.policiesApplied.length > 0 && (
            <>
              <dt className="text-muted-foreground">{t('ask.policies')}</dt>
              <dd>{provenance.policiesApplied.join(', ')}</dd>
            </>
          )}
        </dl>
      )}
      {open === 'sql' && compile.isPending && (
        <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
      )}
      {open === 'sql' && compile.isError && (
        <Alert variant="destructive">
          {rejectionReason(compile.error)
            ? t(`semantic.reasons.${rejectionReason(compile.error)}`, {
                defaultValue: errorMessage(t, compile.error),
              })
            : errorMessage(t, compile.error)}
        </Alert>
      )}
      {open === 'sql' && compile.data && <SqlView compiled={compile.data} />}
    </div>
  );
}

function PanelButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <Button
      variant={active ? 'secondary' : 'ghost'}
      size="sm"
      aria-expanded={active}
      onClick={onClick}
    >
      {icon}
      {label}
      <ChevronDown
        className={active ? 'rotate-180 transition-transform' : 'transition-transform'}
      />
    </Button>
  );
}
