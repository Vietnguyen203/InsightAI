import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { nameColumns, type NamedColumn } from './column-naming';
import { ImportError, type ImportWarning } from './parsing/import-error';

export interface ImportLimits {
  maxRows: number;
  maxColumns: number;
}

export interface RawLoadResult {
  columns: NamedColumn[];
  rowCount: number;
  warnings: ImportWarning[];
}

/** One value as a COPY CSV field: always quoted, so `""` is an empty string and unquoted empty is NULL. */
export function toCopyField(value: string | undefined): string {
  if (value === undefined || value === '') return '';
  // PostgreSQL text cannot contain NUL; such characters are dropped (reported as a warning).
  return `"${value.replaceAll('\u0000', '').replace(/"/g, '""')}"`;
}

/**
 * Creates the raw (all-text) table and streams every data row into it with COPY. Rows get a
 * stable `_row_id` (1-based file order) that later versions keep. Empty cells are stored as NULL.
 */
export async function loadRawTable(
  client: pg.PoolClient,
  rawTable: string,
  source: AsyncIterable<string[]>,
  options: { hasHeader: boolean; limits: ImportLimits },
): Promise<RawLoadResult> {
  const iterator = source[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new ImportError('EMPTY_FILE', 'The file contains no rows');

  const headerCells = options.hasHeader
    ? first.value
    : first.value.map((_, index) => `column_${index + 1}`);
  // Trailing empty header cells (common in Excel exports) are not columns.
  while (headerCells.length > 0 && headerCells.at(-1)?.trim() === '') headerCells.pop();
  if (headerCells.length === 0) throw new ImportError('EMPTY_FILE', 'The header row is empty');
  if (headerCells.length > options.limits.maxColumns) {
    throw new ImportError(
      'TOO_MANY_COLUMNS',
      `The file has ${headerCells.length} columns; the limit is ${options.limits.maxColumns}`,
    );
  }

  const columns = nameColumns(headerCells.map((h) => h.trim()));
  const width = columns.length;
  const id = (value: string) => client.escapeIdentifier(value);

  await client.query(
    `CREATE TABLE ${id(rawTable)} (_row_id bigint PRIMARY KEY, ${columns
      .map((c) => `${id(c.physicalName)} text`)
      .join(', ')})`,
  );

  let rowCount = 0;
  let extraCells = 0;
  let nulChars = 0;

  async function* copyLines(): AsyncIterable<string> {
    if (!options.hasHeader) yield* emit(first.value as string[]);
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield* emit(next.value);
    }
  }

  function* emit(cells: string[]): Iterable<string> {
    if (cells.every((cell) => cell.trim() === '')) return; // blank line
    rowCount += 1;
    if (rowCount > options.limits.maxRows) {
      throw new ImportError(
        'TOO_MANY_ROWS',
        `The file has more than ${options.limits.maxRows.toLocaleString('en-US')} rows`,
      );
    }
    if (cells.length > width && cells.slice(width).some((cell) => cell.trim() !== '')) {
      extraCells += 1;
    }
    let line = String(rowCount);
    for (let i = 0; i < width; i++) {
      const value = cells[i];
      if (value !== undefined && value.includes('\u0000')) nulChars += 1;
      line += `,${toCopyField(value)}`;
    }
    yield `${line}\n`;
  }

  const copy = client.query(
    copyFrom(
      `COPY ${id(rawTable)} (_row_id, ${columns.map((c) => id(c.physicalName)).join(', ')}) FROM STDIN WITH (FORMAT csv)`,
    ),
  );
  await pipeline(Readable.from(copyLines()), copy);

  if (rowCount === 0) throw new ImportError('EMPTY_FILE', 'The file has a header but no data rows');

  const warnings: ImportWarning[] = [];
  const renamed = columns.filter((c) => c.name !== c.originalName);
  if (renamed.length > 0) {
    warnings.push({
      code: 'COLUMNS_RENAMED',
      message: 'Some column names were normalized (lower case, no accents, unique)',
      count: renamed.length,
    });
  }
  if (extraCells > 0) {
    warnings.push({
      code: 'EXTRA_CELLS_IGNORED',
      message: 'Some rows have more values than the header; the extra values were ignored',
      count: extraCells,
    });
  }
  if (nulChars > 0) {
    warnings.push({
      code: 'NUL_CHARACTERS_REMOVED',
      message: 'NUL characters were removed',
      count: nulChars,
    });
  }
  return { columns, rowCount, warnings };
}
