import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorMessage } from '@/lib/errors';
import { organizationsApi } from '../organizations/organizations-api';
import { orgKey, useActiveOrganization } from '../organizations/use-organization';
import { formatDateTime } from '@/lib/format';
import { describeChanges } from './audit-details';
import { PageHeader, Section } from './page-header';

export function AuditPage() {
  const { t, i18n } = useTranslation();
  const { organizationId } = useActiveOrganization();
  const audit = useInfiniteQuery({
    queryKey: orgKey(organizationId, 'audit'),
    queryFn: ({ pageParam }) => organizationsApi.auditLogs(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const entries = audit.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('settings.audit.title')} description={t('settings.audit.description')} />
      <Section title={t('settings.audit.title')}>
        {audit.isError && <Alert variant="destructive">{errorMessage(t, audit.error)}</Alert>}
        {audit.isSuccess && entries.length === 0 && (
          <p className="text-muted-foreground text-sm">{t('settings.audit.empty')}</p>
        )}
        {entries.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('settings.audit.time')}</TableHead>
                <TableHead>{t('settings.audit.actor')}</TableHead>
                <TableHead>{t('settings.audit.action')}</TableHead>
                <TableHead className="hidden lg:table-cell">
                  {t('settings.audit.details')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="text-muted-foreground whitespace-nowrap">
                    {formatDateTime(entry.createdAt, i18n.language)}
                  </TableCell>
                  <TableCell>{entry.actor?.fullName ?? t('settings.audit.formerMember')}</TableCell>
                  <TableCell>
                    {t(`auditActions.${entry.action}`, { defaultValue: entry.action })}
                  </TableCell>
                  <TableCell
                    className="text-muted-foreground hidden max-w-md truncate text-xs lg:table-cell"
                    title={entry.changes ? describeChanges(entry.changes, t) : undefined}
                  >
                    {entry.changes ? describeChanges(entry.changes, t) : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {audit.hasNextPage && (
          <Button
            variant="outline"
            onClick={() => void audit.fetchNextPage()}
            disabled={audit.isFetchingNextPage}
          >
            {t('common.loadMore')}
          </Button>
        )}
      </Section>
    </div>
  );
}
