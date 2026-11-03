import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import iconv from 'iconv-lite';
import type { ImportOptions } from '@insightai/contracts';
import { ImportError } from './import-error';
import { readHead } from './file-format';

const DELIMITERS = [',', ';', '\t', '|'] as const;
type Delimiter = (typeof DELIMITERS)[number];

/**
 * Picks the delimiter that splits the first lines into the most consistent, largest number
 * of fields (outside quotes). Excel in Vietnamese locales commonly writes `;`.
 */
export function sniffDelimiter(sample: string): Delimiter {
  const lines = sample
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, 20);
  if (lines.length === 0) return ',';

  let best: { delimiter: Delimiter; score: number } = { delimiter: ',', score: 0 };
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter));
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    const consistent = counts.filter((count) => count === first).length / counts.length;
    const score = consistent * first;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === delimiter && !inQuotes) count += 1;
  }
  return count;
}

type Encoding = NonNullable<ImportOptions['encoding']>;

function detectEncoding(head: Buffer, requested: Encoding | undefined): Encoding {
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head[0] === 0xfe && head[1] === 0xff) {
    throw new ImportError(
      'UNSUPPORTED_FORMAT',
      'UTF-16 big-endian files are not supported; save as UTF-8',
    );
  }
  return requested ?? 'utf-8';
}

function decodedStream(filePath: string, encoding: Encoding): NodeJS.ReadableStream {
  const raw = createReadStream(filePath);
  if (encoding === 'utf-8') return raw.setEncoding('utf8');
  // iconv-lite strips a UTF-16 BOM itself.
  return raw.pipe(iconv.decodeStream(encoding));
}

export interface CsvSource {
  delimiter: Delimiter;
  encoding: Encoding;
  rows: AsyncIterable<string[]>;
}

/** Streams CSV records as arrays of strings; memory use does not grow with file size. */
export async function openCsv(
  filePath: string,
  options: Pick<ImportOptions, 'delimiter' | 'encoding'>,
): Promise<CsvSource> {
  const head = await readHead(filePath, 64 * 1024);
  const encoding = detectEncoding(head, options.encoding);
  const sample = encoding === 'utf-8' ? head.toString('utf8') : iconv.decode(head, encoding);
  const withoutBom = sample.charCodeAt(0) === 0xfeff ? sample.slice(1) : sample;
  const delimiter = options.delimiter ?? sniffDelimiter(withoutBom);

  const parser = decodedStream(filePath, encoding).pipe(
    parse({
      delimiter,
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      max_record_size: 1024 * 1024,
    }),
  );

  async function* rows(): AsyncIterable<string[]> {
    try {
      for await (const record of parser) yield record as string[];
    } catch (error) {
      if (error instanceof ImportError) throw error;
      const detail = error instanceof Error ? error.message : 'unknown error';
      throw new ImportError('MALFORMED_FILE', `The CSV file could not be parsed: ${detail}`);
    }
  }
  return { delimiter, encoding, rows: rows() };
}
