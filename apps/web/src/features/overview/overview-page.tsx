import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const STEPS = [
  { key: 'datasets', to: '/datasets' },
  { key: 'quality', to: '/datasets' },
  { key: 'semantic', to: '/semantic' },
  { key: 'ask', to: '/ask' },
] as const;

export function OverviewPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{t('overview.title')}</CardTitle>
          <CardDescription>{t('overview.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            {STEPS.map((step) => (
              <li key={step.key}>
                <Link to={step.to} className="hover:underline">
                  {t(`overview.steps.${step.key}`)}
                </Link>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
