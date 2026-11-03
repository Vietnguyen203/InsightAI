import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorMessage } from '@/lib/errors';
import { formatBytes, formatDateTime, formatNumber } from '@/lib/format';
import { orgKey, useActiveOrganization } from '../organizations/use-organization';
import { datasetsApi, importErrorText, isInProgress } from './datasets-api';
import { ImportStatusBadge } from './status-badges';

export function ImportsTab({ datasetId }: { datasetId: string }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { organizationId } = useActiveOrganization();
  const imports = useQuery({
    queryKey: orgKey(organizationId, 'dataset', datasetId, 'imports'),
    queryFn: () => datasetsApi.imports(datasetId),
    refetchInterval: (query) =>
      query.state.data?.some((job) => isInProgress(job.status)) ? 2000 : false,
  });

  if (imports.isError) return <Alert variant="destructive">{errorMessage(t, imports.error)}</Alert>;
  if (!imports.data) return <p className="text-muted-foreground text-sm">{t('common.loading')}</p>;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('datasets.imports.when')}</TableHead>
          <TableHead>{t('datasets.imports.file')}</TableHead>
          <TableHead>{t('datasets.imports.status')}</TableHead>
          <TableHead className="text-right">{t('datasets.imports.rows')}</TableHead>
          <TableHead className="hidden md:table-cell">
            {t('datasets.imports.requestedBy')}
          </TableHead>
          <TableHead className="hidden lg:table-cell">{t('datasets.imports.details')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {imports.data.map((job) => (
          <TableRow key={job.id}>
            <TableCell className="text-muted-foreground whitespace-nowrap">
              {formatDateTime(job.createdAt, lang)}
            </TableCell>
            <TableCell>
              <div className="max-w-56 truncate" title={job.dataSource.originalFilename}>
                {job.dataSource.originalFilename}
              </div>
              <div className="text-muted-foreground text-xs">
                {job.dataSource.fileFormat.toUpperCase()} ·{' '}
                {formatBytes(job.dataSource.sizeBytes, lang)}
              </div>
            </TableCell>
            <TableCell>
              <ImportStatusBadge status={job.status} />
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {job.rowsRead === null ? '—' : formatNumber(job.rowsRead, lang)}
            </TableCell>
            <TableCell className="text-muted-foreground hidden md:table-cell">
              {job.requestedBy?.fullName ?? '—'}
            </TableCell>
            <TableCell className="hidden max-w-sm text-xs lg:table-cell">
              {job.error ? (
                <span className="text-destructive">{importErrorText(t, job.error)}</span>
              ) : (
                <span className="text-muted-foreground">
                  {job.warnings
                    .map((w) => t(`datasets.warnings.${w.code}`, { defaultValue: w.message }))
                    .join(' · ')}
                </span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
