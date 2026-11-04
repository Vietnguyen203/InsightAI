import type { QualityStatus, Severity } from '@insightai/contracts';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const STATUS_VARIANT = {
  UNCHECKED: 'secondary',
  PASSED: 'success',
  WARNING: 'outline',
  FAILED: 'destructive',
} as const;

export function QualityStatusBadge({ status }: { status: QualityStatus }) {
  const { t } = useTranslation();
  return (
    <Badge
      variant={STATUS_VARIANT[status]}
      className={cn(status === 'WARNING' && 'border-warning/40 text-warning')}
    >
      {t(`quality.status.${status}`)}
    </Badge>
  );
}

const RESULT_VARIANT = {
  PASSED: 'success',
  FAILED: 'destructive',
  SKIPPED: 'secondary',
  ERROR: 'outline',
} as const;

export function RuleResultBadge({ status }: { status: keyof typeof RESULT_VARIANT }) {
  const { t } = useTranslation();
  return <Badge variant={RESULT_VARIANT[status]}>{t(`quality.resultStatus.${status}`)}</Badge>;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const { t } = useTranslation();
  return (
    <Badge
      variant={severity === 'error' ? 'destructive' : 'outline'}
      className={cn(severity === 'warning' && 'border-warning/40 text-warning')}
    >
      {t(`quality.severity.${severity}`)}
    </Badge>
  );
}

const JOB_VARIANT = {
  PENDING: 'secondary',
  RUNNING: 'secondary',
  SUCCEEDED: 'success',
  FAILED: 'destructive',
} as const;

/** Status of a quality check or cleaning job. */
export function JobStatusBadge({ status }: { status: keyof typeof JOB_VARIANT }) {
  const { t } = useTranslation();
  return <Badge variant={JOB_VARIANT[status]}>{t(`quality.jobStatus.${status}`)}</Badge>;
}

/** 0–100 score with a color that follows the quality status. */
export function ScoreValue({
  score,
  status,
  className,
}: {
  score: number | null;
  status: QualityStatus;
  className?: string;
}) {
  const { i18n } = useTranslation();
  return (
    <span
      className={cn(
        'font-semibold tabular-nums',
        status === 'PASSED' && 'text-success',
        status === 'WARNING' && 'text-warning',
        status === 'FAILED' && 'text-destructive',
        className,
      )}
    >
      {score === null
        ? '—'
        : score.toLocaleString(i18n.language === 'vi' ? 'vi-VN' : 'en-US', {
            maximumFractionDigits: 1,
          })}
    </span>
  );
}
