import type {
  Evidence,
  HypothesisStatus,
  InvestigationReport,
  ReportParagraph,
} from '@insightai/contracts';
import { FileSearch, Lightbulb } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { AnswerChart } from '../ask/answer-chart';
import { PinToDashboard } from '../dashboards/pin-to-dashboard';
import { Section } from '../settings/page-header';

const HYPOTHESIS_VARIANT: Record<HypothesisStatus, 'success' | 'destructive' | 'outline'> = {
  SUPPORTED: 'success',
  NOT_SUPPORTED: 'destructive',
  INCONCLUSIVE: 'outline',
  UNTESTED: 'outline',
};

/**
 * The rendered report. Every figure is a button that opens the evidence it comes from; charts
 * are drawn from the frozen evidence results, never from a new query.
 */
export function ReportView({
  report,
  evidence,
  onEvidence,
}: {
  report: InvestigationReport;
  evidence: Evidence[] | undefined;
  onEvidence: (evidenceId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const byId = new Map((evidence ?? []).map((e) => [e.id, e]));
  return (
    <article className="space-y-6" aria-label={t('investigations.report.title')}>
      <Section
        title={t('investigations.report.title')}
        description={`${t(`investigations.report.renderer.${report.renderer}`)} · ${formatDateTime(report.createdAt, i18n.language)}`}
      >
        <Paragraph paragraph={report.summary} onEvidence={onEvidence} className="text-base" />
      </Section>

      <Section title={t('investigations.report.findings')}>
        {report.findings.length === 0 && (
          <p className="text-muted-foreground text-sm">{t('investigations.report.noFindings')}</p>
        )}
        <ol className="space-y-6">
          {report.findings.map((f, i) => {
            const source = f.chart ? byId.get(f.chart.evidenceId) : undefined;
            const result = f.chart ? source?.results[f.chart.resultIndex] : undefined;
            return (
              <li key={f.findingId} className="space-y-3 break-inside-avoid">
                <div className="flex items-start gap-3">
                  <span className="bg-muted flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <Paragraph paragraph={f.text} onEvidence={onEvidence} />
                    {!f.verified && (
                      <Badge variant="outline">{t('investigations.report.unverified')}</Badge>
                    )}
                  </div>
                </div>
                {f.chart && result && <AnswerChart spec={f.chart.spec} result={result} />}
                <div className="flex flex-wrap items-center gap-2 print:hidden">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onEvidence(f.evidenceIds[0]!)}
                    disabled={f.evidenceIds.length === 0}
                  >
                    <FileSearch />
                    {t('investigations.evidence.open')}
                  </Button>
                  {f.evidenceIds[0] && (
                    <PinToDashboard widget={{ fromEvidenceId: f.evidenceIds[0] }} />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </Section>

      {report.hypotheses.length > 0 && (
        <Section title={t('investigations.hypotheses')}>
          <ul className="space-y-2 text-sm">
            {report.hypotheses.map((h) => (
              <li key={h.key} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">{h.statement}</span>
                <Badge variant={HYPOTHESIS_VARIANT[h.status]}>{h.label}</Badge>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {report.recommendations.length > 0 && (
        <Section
          title={t('investigations.report.recommendations')}
          description={t('investigations.report.suggestion')}
        >
          <ul className="space-y-2">
            {report.recommendations.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <Lightbulb className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                <div className="space-y-1">
                  <Paragraph paragraph={r.text} onEvidence={onEvidence} />
                  <Badge variant="outline">{t('investigations.report.suggestionBadge')}</Badge>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {report.limitations.length > 0 && (
        <Section title={t('investigations.report.limitations')}>
          <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
            {report.limitations.map((l, i) => (
              <li key={`${l.code}-${i}`}>{l.text}</li>
            ))}
          </ul>
        </Section>
      )}
    </article>
  );
}

/** Text with its figures as buttons tied to their evidence. */
function Paragraph({
  paragraph,
  onEvidence,
  className,
}: {
  paragraph: ReportParagraph;
  onEvidence: (evidenceId: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <p className={className ?? 'text-sm'}>
      {paragraph.segments.map((s, i) =>
        s.type === 'text' ? (
          <span key={i}>{s.text}</span>
        ) : (
          <button
            key={i}
            type="button"
            className="decoration-primary/60 hover:text-primary font-medium tabular-nums underline decoration-dotted underline-offset-4 print:no-underline"
            title={t('investigations.evidence.figure', { name: s.name })}
            onClick={() => onEvidence(s.evidenceId)}
          >
            {s.text}
          </button>
        ),
      )}
    </p>
  );
}
