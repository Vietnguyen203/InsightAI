import type { QueryColumn } from '@insightai/contracts';
import { formatDecimal } from '@/lib/format';

/** Formats a result cell by the column's type and the metric's unit/format. */
export function formatCell(value: string | null, column: QueryColumn, language: string): string {
  if (value === null) return '—';
  if (column.type !== 'INTEGER' && column.type !== 'DECIMAL') return value;
  if (column.format === 'percent')
    return `${formatDecimal(String(Number(value) * 100), language, 1)} %`;
  const number = formatDecimal(value, language, column.type === 'INTEGER' ? 0 : 2);
  return column.unit ? `${number} ${column.unit}` : number;
}
