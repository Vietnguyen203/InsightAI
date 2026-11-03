import { useTranslation } from 'react-i18next';

export function NotFoundPage() {
  const { t } = useTranslation();
  return <p className="text-muted-foreground text-sm">{t('errors.notFound')}</p>;
}
