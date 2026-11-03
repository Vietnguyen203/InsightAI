import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useSystemHealth } from './use-system-health';

const COMPONENTS = ['database', 'redis', 'storage'] as const;

export function SystemStatusPage() {
  const { t } = useTranslation();
  const { data, isPending, isError, isFetching, refetch } = useSystemHealth();

  const statusOf = (key: (typeof COMPONENTS)[number]) =>
    data?.info?.[key]?.status ?? data?.error?.[key]?.status;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('system.title')}</h1>
          <p className="text-muted-foreground text-sm">{t('system.description')}</p>
        </div>
        <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={isFetching ? 'animate-spin' : undefined} />
          {isFetching ? t('system.checking') : t('system.refresh')}
        </Button>
      </div>

      {isError && (
        <Card className="border-destructive/40">
          <CardContent className="text-destructive text-sm">{t('system.unreachable')}</CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {COMPONENTS.map((key) => {
          const status = statusOf(key);
          return (
            <Card key={key}>
              <CardHeader>
                <CardDescription>{t(`system.components.${key}`)}</CardDescription>
                <CardTitle>
                  {isPending ? (
                    <span className="text-muted-foreground text-sm">{t('system.checking')}</span>
                  ) : status ? (
                    <Badge variant={status === 'up' ? 'success' : 'destructive'}>
                      {t(`system.status.${status}`)}
                    </Badge>
                  ) : (
                    <Badge variant="outline">—</Badge>
                  )}
                </CardTitle>
              </CardHeader>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
