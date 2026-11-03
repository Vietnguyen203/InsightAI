import type { CleaningOperationInput, RuleDefinition } from '@insightai/contracts';
import { cleaningOperationSchema } from '@insightai/contracts';
import { describe, expect, it } from 'vitest';
import {
  CleaningCompileError,
  type CompileInput,
  compileCleaning,
  impactSelect,
  resultSelect,
  type SourceColumn,
} from './cleaning-compiler';

const COLUMNS: SourceColumn[] = [
  { ordinal: 1, name: 'ma', originalName: 'Mã', physicalName: 'c_1', dataType: 'TEXT' },
  { ordinal: 2, name: 'ngay', originalName: 'Ngày', physicalName: 'c_2', dataType: 'DATE' },
  { ordinal: 3, name: 'so_luong', originalName: 'SL', physicalName: 'c_3', dataType: 'INTEGER' },
];

function compile(ops: CleaningOperationInput[], overrides: Partial<CompileInput> = {}) {
  return compileCleaning({
    operations: ops.map((op) => cleaningOperationSchema.parse(op)),
    columns: COLUMNS,
    sourceTable: '"t_abcdefgh12"."v_abcdefgh12_abcdefgh"',
    rawTable: '"t_abcdefgh12"."r_abcdefgh12_abcdefgh"',
    locale: 'vi',
    timezone: 'Asia/Ho_Chi_Minh',
    rules: new Map(),
    ...overrides,
  });
}

function compileError(ops: CleaningOperationInput[], overrides: Partial<CompileInput> = {}) {
  try {
    compile(ops, overrides);
  } catch (error) {
    if (error instanceof CleaningCompileError)
      return { index: error.index, message: error.message };
    throw error;
  }
  throw new Error('expected a compile error');
}

describe('compileCleaning', () => {
  it('keeps every row in the chain and filters only in the final select', () => {
    const compiled = compile([{ type: 'drop_rows', condition: 'so_luong < 0' }]);
    expect(compiled.withClause).toContain('NULL::int AS _del');
    expect(compiled.withClause).toContain('THEN 0 ELSE _del END');
    expect(resultSelect(compiled)).toMatch(/FROM s\d+ WHERE _del IS NULL$/);
    expect(impactSelect(compiled)).toContain('count(*) FILTER (WHERE _del = 0) AS d0');
  });

  it('flags changed rows per value-changing operation', () => {
    const compiled = compile([
      { type: 'trim_whitespace', columns: ['ma'] },
      { type: 'rename_column', column: 'ma', newName: 'ma_don' },
      { type: 'change_case', columns: ['ma_don'], mode: 'upper' },
    ]);
    expect(compiled.operations.map((o) => o.flag)).toEqual(['_a0', null, '_a2']);
    expect(impactSelect(compiled)).toContain('count(*) FILTER (WHERE "_a2") AS a2');
    expect(compiled.columns[0]).toMatchObject({ name: 'ma_don', modified: true, removed: false });
  });

  it('escapes user values instead of interpolating them', () => {
    const compiled = compile([
      {
        type: 'replace_values',
        column: 'ma',
        mapping: [{ from: "x'); DROP TABLE y; --", to: "it's" }],
      },
    ]);
    expect(compiled.withClause).toContain(`WHEN 'x''); DROP TABLE y; --' THEN 'it''s'`);
  });

  it('joins the raw table only when an operation re-reads original values', () => {
    expect(compile([{ type: 'trim_whitespace', columns: ['ma'] }]).withClause).not.toContain(
      'LEFT JOIN',
    );
    const cast = compile([{ type: 'cast_column', column: 'so_luong', targetType: 'DECIMAL' }]);
    expect(cast.withClause).toContain('LEFT JOIN "t_abcdefgh12"."r_abcdefgh12_abcdefgh" r');
    expect(cast.columns[2]?.dataType).toBe('DECIMAL');
    // Without a raw table the typed value is re-read.
    const noRaw = compile([{ type: 'cast_column', column: 'so_luong', targetType: 'TEXT' }], {
      rawTable: null,
    });
    expect(noRaw.withClause).not.toContain('LEFT JOIN');
  });

  it('keeps valid dates and tries each requested layout in order', () => {
    const compiled = compile([
      { type: 'parse_date', column: 'ngay', formats: ['dd/MM/yyyy', 'yyyyMMdd'] },
    ]);
    expect(compiled.withClause).toMatch(
      /coalesce\("c_2"::date, CASE .*'DD\/MM\/YYYY'.* END, CASE .*'YYYYMMDD'.* END\)/,
    );
  });

  it('computes an exact median for numbers and groups for fill previous', () => {
    const median = compile([{ type: 'fill_null', column: 'so_luong', strategy: 'median' }]);
    expect(median.withClause).toContain('percentile_disc(0.5)');
    expect(median.withClause).toContain('round(');
    const previous = compile([{ type: 'fill_null', column: 'so_luong', strategy: 'previous' }]);
    expect(previous.withClause).toContain('OVER (ORDER BY _row_id) AS "_g0"');
    expect(previous.withClause).toContain('OVER (PARTITION BY "_g0")');
  });

  it('deduplicates on explicit keys only when the key is complete', () => {
    const compiled = compile([{ type: 'deduplicate', keyColumns: ['ma'], keep: 'last' }]);
    expect(compiled.withClause).toContain('"c_1" IS NOT NULL THEN row_number() OVER');
    expect(compiled.withClause).toContain('ORDER BY _row_id DESC');
  });

  it('removes rows failing a row-level rule', () => {
    const rule: RuleDefinition = { type: 'range', column: 'so_luong', min: '0' };
    const compiled = compile(
      [{ type: 'drop_rows', ruleId: '0195a4a0-0000-7000-8000-000000000001' }],
      { rules: new Map([['0195a4a0-0000-7000-8000-000000000001', rule]]) },
    );
    expect(compiled.withClause).toContain('"c_3" < 0::numeric');
  });

  it('reports the failing operation', () => {
    expect(compileError([{ type: 'trim_whitespace', columns: ['so_luong'] }])).toMatchObject({
      index: 0,
      message: expect.stringContaining('text column') as unknown,
    });
    expect(
      compileError([
        { type: 'drop_column', column: 'ma' },
        { type: 'change_case', columns: ['ma'], mode: 'lower' },
      ]),
    ).toMatchObject({ index: 1 });
    expect(
      compileError([{ type: 'rename_column', column: 'ma', newName: 'so_luong' }]),
    ).toMatchObject({ index: 0, message: expect.stringContaining('already exists') as unknown });
    expect(compileError([{ type: 'drop_rows', condition: 'ma + 1' }])).toMatchObject({ index: 0 });
    expect(
      compileError([{ type: 'drop_rows', ruleId: '0195a4a0-0000-7000-8000-000000000002' }]),
    ).toMatchObject({ message: 'The quality rule does not exist' });
    expect(
      compileError([{ type: 'drop_rows', ruleId: '0195a4a0-0000-7000-8000-000000000003' }], {
        rules: new Map([
          ['0195a4a0-0000-7000-8000-000000000003', { type: 'unique', columns: ['ma'] }],
        ]),
      }),
    ).toMatchObject({ message: expect.stringContaining('deduplicate') as unknown });
    expect(
      compileError([
        {
          type: 'replace_values',
          column: 'ma',
          mapping: [
            { from: 'a', to: 'b' },
            { from: 'a', to: 'c' },
          ],
        },
      ]),
    ).toMatchObject({ index: 0 });
    expect(
      compileError([
        { type: 'fill_null', column: 'ngay', strategy: 'constant', value: '31/12/2026' },
      ]),
    ).toMatchObject({ index: 0 });
    expect(
      compileError([
        { type: 'drop_column', column: 'ma' },
        { type: 'drop_column', column: 'ngay' },
        { type: 'drop_column', column: 'so_luong' },
      ]),
    ).toMatchObject({ index: 2, message: 'The last column cannot be removed' });
  });

  it('refuses identifiers that do not come from metadata', () => {
    expect(() => compile([], { sourceTable: 'public.users' })).toThrow('Unexpected source table');
    expect(() =>
      compile([], {
        columns: [{ ...COLUMNS[0]!, physicalName: 'c_1"; DROP TABLE x; --' }],
      }),
    ).toThrow('Unexpected column identifier');
  });
});

describe('cleaningOperationSchema', () => {
  it('requires exactly one of condition or ruleId for drop_rows', () => {
    expect(cleaningOperationSchema.safeParse({ type: 'drop_rows' }).success).toBe(false);
    expect(
      cleaningOperationSchema.safeParse({
        type: 'drop_rows',
        condition: 'a > 1',
        ruleId: '0195a4a0-0000-7000-8000-000000000001',
      }).success,
    ).toBe(false);
  });

  it('requires a value for constant fills and a valid new column name', () => {
    expect(
      cleaningOperationSchema.safeParse({ type: 'fill_null', column: 'a', strategy: 'constant' })
        .success,
    ).toBe(false);
    expect(
      cleaningOperationSchema.safeParse({ type: 'rename_column', column: 'a', newName: 'Bad Name' })
        .success,
    ).toBe(false);
  });
});
