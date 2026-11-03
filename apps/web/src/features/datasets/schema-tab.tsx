import type { DatasetColumn } from '@insightai/contracts';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatNumber, formatPercent } from '@/lib/format';

/** Detected structure: names, types, how well values matched, and values that could not be converted. */
export function SchemaTab({ columns }: { columns: DatasetColumn[] }) {
  const { t, i18n } = useTranslation();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('datasets.schema.column')}</TableHead>
          <TableHead className="hidden md:table-cell">{t('datasets.schema.original')}</TableHead>
          <TableHead>{t('datasets.schema.type')}</TableHead>
          <TableHead className="hidden sm:table-cell">{t('datasets.schema.format')}</TableHead>
          <TableHead className="text-right">{t('datasets.schema.confidence')}</TableHead>
          <TableHead className="text-right">{t('datasets.schema.filled')}</TableHead>
          <TableHead className="text-right">{t('datasets.schema.invalid')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {columns.map((column) => {
          const overridden = column.dataType !== column.inferredType;
          return (
            <TableRow key={column.name}>
              <TableCell className="font-mono text-xs">{column.name}</TableCell>
              <TableCell className="text-muted-foreground hidden md:table-cell">
                {column.originalName}
              </TableCell>
              <TableCell>
                <Badge
                  variant={overridden ? 'outline' : 'secondary'}
                  title={
                    overridden
                      ? t('datasets.schema.overridden', {
                          type: t(`datasets.types.${column.inferredType}`),
                        })
                      : undefined
                  }
                >
                  {t(`datasets.types.${column.dataType}`)}
                  {overridden && ' *'}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground hidden sm:table-cell">
                {column.detectedFormat ?? '—'}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPercent(column.typeConfidence, i18n.language)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatNumber(column.nonEmptyCount, i18n.language)}
              </TableCell>
              <TableCell
                className={
                  column.invalidCount > 0
                    ? 'text-destructive text-right font-medium tabular-nums'
                    : 'text-muted-foreground text-right tabular-nums'
                }
              >
                {formatNumber(column.invalidCount, i18n.language)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
