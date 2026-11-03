import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import yauzl from 'yauzl';
import { ImportError } from './import-error';

export type FileFormat = 'csv' | 'xlsx';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

export async function readHead(filePath: string, bytes = 8192): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Decides the format from the extension AND the content: the extension alone is attacker-chosen.
 * `.xls` (legacy binary) and macro-enabled `.xlsm` are rejected.
 */
export function detectFileFormat(filename: string, head: Buffer): FileFormat {
  const extension = extname(filename).toLowerCase();
  if (head.length === 0) throw new ImportError('EMPTY_FILE', 'The file is empty');

  if (extension === '.xlsx') {
    if (!head.subarray(0, 4).equals(ZIP_MAGIC)) {
      throw new ImportError('UNSUPPORTED_FORMAT', 'The file is not a valid .xlsx workbook');
    }
    return 'xlsx';
  }
  if (extension === '.csv' || extension === '.txt') {
    const isUtf16 =
      head.subarray(0, 2).equals(UTF16LE_BOM) || head.subarray(0, 2).equals(UTF16BE_BOM);
    if (!isUtf16 && head.includes(0)) {
      throw new ImportError('UNSUPPORTED_FORMAT', 'The file looks binary, not like CSV text');
    }
    return 'csv';
  }
  throw new ImportError(
    'UNSUPPORTED_FORMAT',
    `Unsupported file type "${extension || '(none)'}". Use .csv or .xlsx`,
  );
}

export interface ZipLimits {
  maxUncompressedBytes: number;
  maxEntries: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxUncompressedBytes: 1024 * 1024 * 1024, // 1 GiB of XML is far beyond 2M rows × 300 cols of real data
  maxEntries: 10_000,
};

/**
 * Zip-bomb guard for XLSX: reads only the central directory (no decompression) and rejects
 * archives whose declared uncompressed size or entry count is excessive.
 */
export function assertSafeZip(
  filePath: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(
          new ImportError('MALFORMED_FILE', 'The .xlsx file is corrupted or not a zip archive'),
        );
        return;
      }
      let total = 0;
      let entries = 0;
      zip.on('entry', (entry: yauzl.Entry) => {
        entries += 1;
        total += entry.uncompressedSize;
        if (entries > limits.maxEntries || total > limits.maxUncompressedBytes) {
          zip.close();
          reject(new ImportError('UNSAFE_ARCHIVE', 'The .xlsx file expands to an unsafe size'));
          return;
        }
        zip.readEntry();
      });
      zip.on('end', () => resolve());
      zip.on('error', () =>
        reject(
          new ImportError('MALFORMED_FILE', 'The .xlsx file is corrupted or not a zip archive'),
        ),
      );
      zip.readEntry();
    });
  });
}
