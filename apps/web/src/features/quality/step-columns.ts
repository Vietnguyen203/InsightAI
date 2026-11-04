import type { CleaningOperationInput, ColumnDataType } from '@insightai/contracts';

export interface StepColumn {
  name: string;
  dataType: ColumnDataType;
}

/** Columns as they are after the given operations (renames, removals and type changes). */
export function columnsAfter(
  columns: StepColumn[],
  operations: CleaningOperationInput[],
): StepColumn[] {
  let current = columns.map((c) => ({ ...c }));
  for (const op of operations) {
    if (op.type === 'rename_column') {
      current = current.map((c) => (c.name === op.column ? { ...c, name: op.newName } : c));
    } else if (op.type === 'drop_column') {
      current = current.filter((c) => c.name !== op.column);
    } else if (op.type === 'cast_column') {
      current = current.map((c) => (c.name === op.column ? { ...c, dataType: op.targetType } : c));
    } else if (op.type === 'parse_date') {
      current = current.map((c) => (c.name === op.column ? { ...c, dataType: 'DATE' } : c));
    }
  }
  return current;
}
