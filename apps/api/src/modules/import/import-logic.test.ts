import { describe, expect, it } from 'vitest';
import { nameColumns, normalizeColumnName } from './column-naming';
import { detectFileFormat } from './parsing/file-format';
import { sniffDelimiter } from './parsing/csv-reader';
import { columnNumber, isDateFormat, serialToText } from './parsing/xlsx-reader';
import { toCopyField } from './raw-loader';
import { candidatesFor, castExpression, inferType, type ColumnStats } from './type-inference';

describe('column naming', () => {
  it('normalizes Vietnamese headers', () => {
    expect(normalizeColumnName('Doanh thu (VNĐ)')).toBe('doanh_thu_vnd');
    expect(normalizeColumnName('  Ngày đặt hàng ')).toBe('ngay_dat_hang');
  });

  it('makes names unique and never uses file content as the physical name', () => {
    const columns = nameColumns(['Tên', 'tên', '', '2024', '"; DROP TABLE x; --']);
    expect(columns.map((c) => c.name)).toEqual([
      'ten',
      'ten_2',
      'column_3',
      'c_2024',
      'drop_table_x',
    ]);
    expect(columns.map((c) => c.physicalName)).toEqual(['c_1', 'c_2', 'c_3', 'c_4', 'c_5']);
    expect(columns[4]?.originalName).toBe('"; DROP TABLE x; --');
  });
});

describe('type inference decision', () => {
  const vi = candidatesFor('vi');
  const stats = (nonEmpty: number, matches: Record<string, number>): ColumnStats => ({
    nonEmpty,
    matches,
  });

  it('prefers the narrowest type that matches at least 95%', () => {
    expect(inferType(stats(100, { integer_vi: 100, decimal_vi: 100 }), vi).type).toBe('INTEGER');
    expect(inferType(stats(100, { integer_vi: 90, decimal_vi: 100 }), vi).type).toBe('DECIMAL');
    expect(inferType(stats(100, { date_dmy: 96 }), vi)).toMatchObject({
      type: 'DATE',
      confidence: 0.96,
    });
  });

  it('falls back to TEXT below the threshold or when the column is empty', () => {
    expect(inferType(stats(100, { integer_vi: 94 }), vi).type).toBe('TEXT');
    expect(inferType(stats(0, {}), vi).type).toBe('TEXT');
  });

  it('builds cast expressions from fixed fragments only', () => {
    const inferred = inferType(stats(10, { decimal_vi: 10 }), vi);
    const sql = castExpression('"c_3"', inferred);
    expect(sql).toContain(
      "dp.try_numeric(replace(replace(NULLIF(btrim(\"c_3\"), ''), '.', ''), ',', '.'))",
    );
    expect(sql).toMatch(/^CASE WHEN NULLIF\(btrim\("c_3"\), ''\) ~\* '/);
  });

  it('keeps TEXT values as-is except empty strings', () => {
    expect(castExpression('"c_1"', { type: 'TEXT', candidate: null, confidence: 1 })).toBe(
      'NULLIF("c_1", \'\')',
    );
  });
});

describe('CSV helpers', () => {
  it('sniffs the delimiter', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3\n4;5;6')).toBe(';');
    expect(sniffDelimiter('a,b\n"1,5",2\n3,4')).toBe(',');
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('quotes every COPY field and maps empty cells to NULL', () => {
    expect(toCopyField(undefined)).toBe('');
    expect(toCopyField('')).toBe('');
    expect(toCopyField('He said "hi", ok')).toBe('"He said ""hi"", ok"');
    expect(toCopyField('a\u0000b')).toBe('"ab"');
  });
});

describe('file format detection', () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]);
  const text = Buffer.from('a,b\n1,2\n');

  it('requires matching extension and content', () => {
    expect(detectFileFormat('sales.xlsx', zip)).toBe('xlsx');
    expect(detectFileFormat('sales.CSV', text)).toBe('csv');
    expect(() => detectFileFormat('sales.xlsx', text)).toThrow(/not a valid \.xlsx/);
    expect(() => detectFileFormat('sales.csv', Buffer.from([0x4d, 0x5a, 0x00, 0x01]))).toThrow(
      /binary/,
    );
  });

  it('rejects legacy and macro-enabled formats', () => {
    expect(() => detectFileFormat('sales.xls', zip)).toThrow(/Unsupported/);
    expect(() => detectFileFormat('sales.xlsm', zip)).toThrow(/Unsupported/);
    expect(() => detectFileFormat('sales.csv', Buffer.alloc(0))).toThrow(/empty/);
  });
});

describe('XLSX helpers', () => {
  it('converts cell references to column numbers', () => {
    expect(columnNumber('A1')).toBe(1);
    expect(columnNumber('Z9')).toBe(26);
    expect(columnNumber('AB12')).toBe(28);
  });

  it('recognises date number formats', () => {
    expect(isDateFormat('dd/mm/yyyy')).toBe(true);
    expect(isDateFormat('[$-42A]dd/mm/yyyy h:mm')).toBe(true);
    expect(isDateFormat('[h]:mm:ss')).toBe(true);
    expect(isDateFormat('#,##0.00 "đ"')).toBe(false);
    expect(isDateFormat('[Red]#,##0;-#,##0')).toBe(false);
    expect(isDateFormat('General')).toBe(false);
  });

  it('converts Excel serials to wall-clock text', () => {
    expect(serialToText(46329, false)).toBe('2026-11-03');
    expect(serialToText(46329.5, false)).toBe('2026-11-03T12:00:00');
    expect(serialToText(0, true)).toBe('1904-01-01');
  });
});
