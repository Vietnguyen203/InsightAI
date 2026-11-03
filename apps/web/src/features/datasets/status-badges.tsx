import type { ImportStatus, ProfileStatus } from '@insightai/contracts';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';

const VARIANT = {
  PENDING: 'secondary',
  RUNNING: 'secondary',
  SUCCEEDED: 'success',
  FAILED: 'destructive',
} as const;

export function ImportStatusBadge({ status }: { status: ImportStatus }) {
  const { t } = useTranslation();
  return <Badge variant={VARIANT[status]}>{t(`datasets.importStatus.${status}`)}</Badge>;
}

export function ProfileStatusBadge({ status }: { status: ProfileStatus }) {
  const { t } = useTranslation();
  return <Badge variant={VARIANT[status]}>{t(`datasets.profileStatus.${status}`)}</Badge>;
}

export function DatasetStatusBadge({ status }: { status: 'DRAFT' | 'READY' | 'ARCHIVED' }) {
  const { t } = useTranslation();
  const variant = status === 'READY' ? 'success' : 'secondary';
  return <Badge variant={variant}>{t(`datasets.status.${status}`)}</Badge>;
}
