import type { RowsPage } from '@insightai/contracts';
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
import { formatDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';
import { orgKey, useActiveOrganization } from '../organizations/use-organization';
import { datasetsApi } from './datasets-api';

const PAGE_SIZE = 50;

/** Spreadsheet-like preview of the active version, loaded page by page (keyset on row id). */
export function DataTab({ datasetId, versionId }: { datasetId: string; versionId: string }) {
  const { t, i18n } = useTranslation();
  const { organizationId } = useActiveOrganization();
  const rows = useInfiniteQuery({
    queryKey: orgKey(organizationId, 'dataset', datasetId, 'rows', versionId),
    queryFn: ({ pageParam }) =>
      datasetsApi.rows(datasetId, { versionId, after: pageParam, limit: PAGE_SIZE }),
    initialPageParam: 0,
    getNextPageParam: (page: RowsPage) => page.nextAfter ?? undefined,
  });

  if (rows.isError) return <Alert variant="destructive">{errorMessage(t, rows.error)}</Alert>;
  if (!rows.data) return <p className="text-muted-foreground text-sm">{t('common.loading')}</p>;

  const columns = rows.data.pages[0]?.columns ?? [];
  const numeric = columns.map((c) => c.dataType === 'INTEGER' || c.dataType === 'DECIMAL');
  const all = rows.data.pages.flatMap((page) => page.rows);

  return (
    <div className="space-y-3">
      <div className="max-h-[60vh] overflow-auto rounded-md border">
        <Table>
          <TableHeader className="bg-background sticky top-0 z-10">
            <TableRow>
              <TableHead className="text-right">#</TableHead>
              {columns.map((column, i) => (
                <TableHead
                  key={column.name}
                  title={column.originalName}
                  className={cn(numeric[i] && 'text-right')}
                >
                  {column.originalName}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {all.map((row) => (
              <TableRow key={row.rowId}>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {row.rowId}
                </TableCell>
                {row.values.map((value, i) => (
                  <TableCell
                    key={columns[i]?.name ?? i}
                    className={cn(
                      'max-w-xs truncate whitespace-nowrap',
                      numeric[i] && 'text-right tabular-nums',
                    )}
                    title={value ?? undefined}
                  >
                    {value === null ? (
                      <span className="text-muted-foreground/60 italic">
                        {t('datasets.data.empty')}
                      </span>
                    ) : numeric[i] ? (
                      formatDecimal(value, i18n.language)
                    ) : columns[i]?.dataType === 'BOOLEAN' ? (
                      t(value === 'true' ? 'datasets.data.true' : 'datasets.data.false')
                    ) : (
                      value
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {rows.hasNextPage && (
        <Button
          variant="outline"
          onClick={() => void rows.fetchNextPage()}
          disabled={rows.isFetchingNextPage}
        >
          {t('datasets.data.loadMore')}
        </Button>
      )}
    </div>
  );
}
