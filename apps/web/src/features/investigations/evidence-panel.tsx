import type { Evidence, InvestigationStep } from '@insightai/contracts';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { ResultTable } from '../semantic/query-tab';

/**
 * What a figure rests on, as frozen when the step ran: the queries (IR), the versions of the
 * model, metrics and datasets, the access policies applied and the result rows.
 */
export function EvidencePanel({
  evidence,
  step,
  onClose,
}: {
  evidence: Evidence;
  step: InvestigationStep | undefined;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const v = evidence.versions;
  return (
    <section
      className="bg-card space-y-4 rounded-xl border p-4 md:p-6"
      aria-label={t('investigations.evidence.title')}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{t('investigations.evidence.title')}</h2>
          <p className="text-muted-foreground text-sm">
            {step?.purpose ?? evidence.stepKey} ·{' '}
            {t(`investigations.tools.${evidence.kind}`, { defaultValue: evidence.kind })} ·{' '}
            {formatDateTime(evidence.createdAt, i18n.language)}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('common.close')}>
          <X />
        </Button>
      </div>

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{t('investigations.evidence.model')}</dt>
        <dd>{t('investigations.evidence.revision', { revision: v.modelRevision })}</dd>
        <dt className="text-muted-foreground">{t('investigations.evidence.metrics')}</dt>
        <dd className="flex flex-wrap gap-1">
          {v.metrics.map((m) => (
            <Badge key={m.key} variant="secondary">
              {m.key} · v{m.version}
            </Badge>
          ))}
        </dd>
        <dt className="text-muted-foreground">{t('investigations.evidence.datasets')}</dt>
        <dd className="space-y-0.5">
          {v.datasets.map((d) => (
            <p key={`${d.id}-${d.versionNo}`}>
              {t('investigations.evidence.dataset', {
                name: d.name,
                version: d.versionNo,
                quality:
                  d.qualityScore === null
                    ? t('investigations.evidence.noScore')
                    : Math.round(d.qualityScore),
              })}
            </p>
          ))}
        </dd>
        {evidence.policiesApplied.length > 0 && (
          <>
            <dt className="text-muted-foreground">{t('investigations.evidence.policies')}</dt>
            <dd>{evidence.policiesApplied.join(', ')}</dd>
          </>
        )}
        {evidence.limitations.length > 0 && (
          <>
            <dt className="text-muted-foreground">{t('investigations.evidence.limitations')}</dt>
            <dd className="flex flex-wrap gap-1">
              {evidence.limitations.map((l) => (
                <Badge key={l} variant="outline">
                  {l}
                </Badge>
              ))}
            </dd>
          </>
        )}
      </dl>

      {evidence.results.map((result, i) => (
        <div key={i} className="space-y-2">
          <h3 className="text-sm font-medium">
            {t('investigations.evidence.result', { n: i + 1, total: evidence.results.length })}
          </h3>
          <ResultTable result={result} />
          {evidence.queries[i] && (
            <details className="text-xs">
              <summary className="text-muted-foreground cursor-pointer">
                {t('investigations.evidence.query')}
              </summary>
              <pre className="bg-muted mt-1 overflow-x-auto rounded-md p-2">
                {JSON.stringify(evidence.queries[i], null, 2)}
              </pre>
            </details>
          )}
        </div>
      ))}
    </section>
  );
}
