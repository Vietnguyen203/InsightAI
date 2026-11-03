import type { Readable } from 'node:stream';
import sax from 'sax';
import yauzl from 'yauzl';
import { ImportError } from './import-error';

/**
 * Minimal streaming XLSX reader (decision D-27).
 *
 * XLSX is a zip of XML parts. Readers that consume the zip sequentially depend on the order in
 * which the producing tool wrote the parts (workbook.xml, styles, shared strings, sheets); with
 * an unlucky order they crash or silently read dates as numbers. This reader uses the zip
 * central directory to read the small metadata parts first, then streams only the target sheet.
 * Memory: shared strings are held in memory (bounded by the zip-bomb guard); rows are streamed.
 */

const MAX_METADATA_BYTES = 256 * 1024 * 1024;

const malformed = (detail: string) =>
  new ImportError('MALFORMED_FILE', `The .xlsx file could not be read: ${detail}`);

// ─── zip access ─────────────────────────────────────────────────────────────

interface ZipIndex {
  zip: yauzl.ZipFile;
  entries: Map<string, yauzl.Entry>;
}

function openZip(filePath: string): Promise<ZipIndex> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (error, zip) => {
      if (error || !zip) {
        reject(
          new ImportError('MALFORMED_FILE', 'The .xlsx file is corrupted or not a zip archive'),
        );
        return;
      }
      const entries = new Map<string, yauzl.Entry>();
      zip.on('entry', (entry: yauzl.Entry) => {
        entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.on('end', () => resolve({ zip, entries }));
      zip.on('error', () => reject(malformed('invalid zip structure')));
      zip.readEntry();
    });
  });
}

function openEntry(index: ZipIndex, name: string): Promise<Readable> {
  const entry = index.entries.get(name);
  if (!entry) return Promise.reject(malformed(`missing part ${name}`));
  return new Promise((resolve, reject) => {
    index.zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(malformed(`cannot open ${name}`));
      else resolve(stream);
    });
  });
}

/** Feeds an XML part to a SAX parser chunk by chunk, yielding after each chunk. */
async function* saxChunks(stream: Readable, parser: sax.SAXParser): AsyncIterable<void> {
  let failure: Error | null = null;
  parser.onerror = (error) => {
    failure = error;
  };
  for await (const chunk of stream) {
    parser.write((chunk as Buffer).toString('utf8'));
    if (failure) throw malformed((failure as Error).message);
    yield;
  }
  parser.close();
  if (failure) throw malformed((failure as Error).message);
}

async function parseWhole(index: ZipIndex, name: string, parser: sax.SAXParser): Promise<void> {
  const entry = index.entries.get(name);
  if (!entry) return;
  if (entry.uncompressedSize > MAX_METADATA_BYTES) throw malformed(`${name} is too large`);
  for await (const _ of saxChunks(await openEntry(index, name), parser)) {
    // consume
  }
}

const newParser = () => sax.parser(true, { trim: false, normalize: false, lowercase: false });

/** "AB12" → 28 (1-based column number). */
export function columnNumber(cellRef: string): number {
  let n = 0;
  for (const char of cellRef) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n;
}

// ─── workbook & sheets ─────────────────────────────────────────────────────

export interface SheetRef {
  name: string;
  /** Zip path of the worksheet part, e.g. xl/worksheets/sheet3.xml. */
  part: string;
}

interface WorkbookInfo {
  sheets: SheetRef[];
  date1904: boolean;
}

async function readWorkbook(index: ZipIndex): Promise<WorkbookInfo> {
  const targets = new Map<string, string>();
  const rels = newParser();
  rels.onopentag = (tag) => {
    if (tag.name === 'Relationship') {
      const id = tag.attributes.Id;
      const target = tag.attributes.Target;
      if (typeof id === 'string' && typeof target === 'string') targets.set(id, target);
    }
  };
  await parseWhole(index, 'xl/_rels/workbook.xml.rels', rels);

  const sheets: SheetRef[] = [];
  let date1904 = false;
  const workbook = newParser();
  workbook.onopentag = (tag) => {
    if (tag.name === 'workbookPr') {
      const value = tag.attributes.date1904;
      date1904 = value === '1' || value === 'true';
    }
    if (tag.name === 'sheet') {
      const name = tag.attributes.name;
      const relId = tag.attributes['r:id'];
      const target = typeof relId === 'string' ? targets.get(relId) : undefined;
      if (typeof name === 'string' && target) {
        // Targets are relative to xl/ unless absolute.
        const part = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
        sheets.push({ name, part });
      }
    }
  };
  if (!index.entries.has('xl/workbook.xml')) throw malformed('missing workbook definition');
  await parseWhole(index, 'xl/workbook.xml', workbook);
  return { sheets, date1904 };
}

// ─── styles: which cell styles are dates ───────────────────────────────────

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** True when an Excel number format renders a date or time. */
export function isDateFormat(formatCode: string): boolean {
  const cleaned = formatCode
    .replace(/"[^"]*"/g, '') // literal text
    .replace(/\\./g, '') // escaped characters
    .replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, '') // [Red], [$-409], but keep elapsed [h] [m] [s]
    .toLowerCase();
  if (cleaned === '' || cleaned === 'general') return false;
  return /[dmyhs]/.test(cleaned);
}

async function readDateStyles(index: ZipIndex): Promise<Set<number>> {
  const customFormats = new Map<number, string>();
  const xfFormats: number[] = [];
  let inCellXfs = false;

  const parser = newParser();
  parser.onopentag = (tag) => {
    if (tag.name === 'numFmt') {
      const id = Number(tag.attributes.numFmtId);
      const code = tag.attributes.formatCode;
      if (Number.isInteger(id) && typeof code === 'string') customFormats.set(id, code);
    } else if (tag.name === 'cellXfs') {
      inCellXfs = true;
    } else if (tag.name === 'xf' && inCellXfs) {
      xfFormats.push(Number(tag.attributes.numFmtId ?? 0));
    }
  };
  parser.onclosetag = (name) => {
    if (name === 'cellXfs') inCellXfs = false;
  };
  await parseWhole(index, 'xl/styles.xml', parser);

  const dateStyles = new Set<number>();
  xfFormats.forEach((formatId, styleIndex) => {
    const custom = customFormats.get(formatId);
    if (BUILTIN_DATE_FORMATS.has(formatId) || (custom !== undefined && isDateFormat(custom))) {
      dateStyles.add(styleIndex);
    }
  });
  return dateStyles;
}

// ─── shared strings ─────────────────────────────────────────────────────────

async function readSharedStrings(index: ZipIndex): Promise<string[]> {
  const strings: string[] = [];
  let current: string[] | null = null;
  let inText = false;
  let inPhonetic = false;

  const parser = newParser();
  parser.onopentag = (tag) => {
    if (tag.name === 'si') current = [];
    else if (tag.name === 'rPh')
      inPhonetic = true; // East Asian reading hints, not cell text
    else if (tag.name === 't' && !inPhonetic) inText = true;
  };
  const onText = (text: string) => {
    if (inText && current) current.push(text);
  };
  parser.ontext = onText;
  parser.oncdata = onText;
  parser.onclosetag = (name) => {
    if (name === 't') inText = false;
    else if (name === 'rPh') inPhonetic = false;
    else if (name === 'si' && current) {
      strings.push(current.join(''));
      current = null;
    }
  };
  await parseWhole(index, 'xl/sharedStrings.xml', parser);
  return strings;
}

// ─── values ─────────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;
const EPOCH_1900 = Date.UTC(1899, 11, 30); // accounts for Excel's fictitious 1900-02-29
const EPOCH_1904 = Date.UTC(1904, 0, 1);

/** Excel date serial → wall-clock text: "yyyy-MM-dd" or "yyyy-MM-ddTHH:mm:ss". */
export function serialToText(serial: number, date1904: boolean): string {
  const ms = Math.round(((date1904 ? EPOCH_1904 : EPOCH_1900) + serial * MS_PER_DAY) / 1000) * 1000;
  const iso = new Date(ms).toISOString();
  return ms % MS_PER_DAY === 0 ? iso.slice(0, 10) : iso.slice(0, 19);
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Streams rows of one worksheet: the first one in workbook order unless `sheetName` is given.
 * Values are machine-formatted text: numbers as stored (1234.5), dates as ISO, booleans true/false.
 */
export async function* readXlsxRows(filePath: string, sheetName?: string): AsyncIterable<string[]> {
  const index = await openZip(filePath);
  try {
    const workbook = await readWorkbook(index);
    const sheet =
      sheetName === undefined
        ? workbook.sheets[0]
        : workbook.sheets.find((s) => s.name === sheetName);
    if (!sheet) {
      throw new ImportError(
        'SHEET_NOT_FOUND',
        sheetName ? `Worksheet "${sheetName}" was not found` : 'The workbook has no worksheets',
      );
    }
    const dateStyles = await readDateStyles(index);
    const sharedStrings = await readSharedStrings(index);

    const pending: string[][] = [];
    let row: string[] | null = null;
    let cell: { col: number; type: string; style: number } | null = null;
    let value = '';
    let capture = false;
    let inInline = false;

    const parser = newParser();
    parser.onopentag = (tag) => {
      switch (tag.name) {
        case 'row':
          row = [];
          break;
        case 'c': {
          const ref = typeof tag.attributes.r === 'string' ? tag.attributes.r : '';
          cell = {
            col: ref ? columnNumber(ref) : (row?.length ?? 0) + 1,
            type: typeof tag.attributes.t === 'string' ? tag.attributes.t : 'n',
            style: Number(tag.attributes.s ?? 0),
          };
          value = '';
          break;
        }
        case 'v':
          capture = true;
          break;
        case 'is':
          inInline = true;
          break;
        case 't':
          if (inInline) capture = true;
          break;
      }
    };
    const onText = (text: string) => {
      if (capture) value += text;
    };
    parser.ontext = onText;
    parser.oncdata = onText;
    parser.onclosetag = (name) => {
      if (name === 'v' || name === 't') capture = false;
      else if (name === 'is') inInline = false;
      else if (name === 'c' && cell && row) {
        let text: string;
        switch (cell.type) {
          case 's':
            text = sharedStrings[Number(value)] ?? '';
            break;
          case 'b':
            text = value === '1' ? 'true' : value === '0' ? 'false' : '';
            break;
          case 'e': // #N/A, #DIV/0! ...
            text = '';
            break;
          case 'str':
          case 'inlineStr':
          case 'd':
            text = value;
            break;
          default: {
            const number = Number(value);
            text =
              value !== '' && Number.isFinite(number) && dateStyles.has(cell.style)
                ? serialToText(number, workbook.date1904)
                : value;
          }
        }
        while (row.length < cell.col - 1) row.push('');
        row[cell.col - 1] = text;
        cell = null;
      } else if (name === 'row' && row) {
        pending.push(row);
        row = null;
      }
    };

    for await (const _ of saxChunks(await openEntry(index, sheet.part), parser)) {
      while (pending.length > 0) yield pending.shift()!;
    }
    while (pending.length > 0) yield pending.shift()!;
  } finally {
    index.zip.close();
  }
}
