import { useTranslation } from 'react-i18next';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function OverviewPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{t('overview.title')}</CardTitle>
          <CardDescription>{t('overview.description')}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
