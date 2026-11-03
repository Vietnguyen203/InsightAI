import { describe, expect, it } from 'vitest';
import {
  compileRule,
  computeScore,
  RuleDefinitionError,
  ruleStatus,
  type VersionColumn,
} from './rule-compiler';

const col = (
  name: string,
  dataType: VersionColumn['dataType'],
  n: number,
): [string, VersionColumn] => [
  name,
  { name, dataType, typedSql: `t."c_${n}"`, rawSql: `r."c_${n}"` },
];
const columns = new Map([
  col('ma_don', 'TEXT', 1),
  col('ngay_dat', 'DATE', 2),
  col('doanh_thu', 'DECIMAL', 3),
  col('trang_thai', 'TEXT', 4),
  col('ngay_tt', 'TIMESTAMP', 5),
]);

describe('rule compiler', () => {
  it('not_null treats blank text as missing', () => {
    expect(compileRule({ type: 'not_null', column: 'ma_don' }, columns)).toMatchObject({
      kind: 'row',
      applies: 'true',
      fails: `(t."c_1" IS NULL OR btrim(t."c_1") = '')`,
    });
    expect(compileRule({ type: 'not_null', column: 'ngay_dat' }, columns)).toMatchObject({
      fails: 't."c_2" IS NULL',
    });
  });

  it('type_castable compares the raw text with the typed value', () => {
    expect(compileRule({ type: 'type_castable', column: 'ngay_dat' }, columns)).toEqual({
      kind: 'row',
      applies: `NULLIF(btrim(r."c_2"), '') IS NOT NULL`,
      fails: 't."c_2" IS NULL',
      sampleColumn: columns.get('ngay_dat'),
      needsRaw: true,
    });
  });

  it('escapes user literals', () => {
    const rule = compileRule(
      {
        type: 'allowed_values',
        column: 'trang_thai',
        values: ['PAID', "it's"],
        caseSensitive: false,
      },
      columns,
    );
    expect(rule).toMatchObject({ fails: `lower(t."c_4"::text) NOT IN ('paid', 'it''s')` });
    expect(
      compileRule({ type: 'regex', column: 'ma_don', pattern: "^DH\\d{4}$'" }, columns),
    ).toMatchObject({
      fails: `t."c_1" !~ E'^DH\\\\d{4}$'''`,
    });
  });

  it('validates range bounds against the column type', () => {
    expect(compileRule({ type: 'range', column: 'doanh_thu', min: '0' }, columns)).toMatchObject({
      fails: '(t."c_3" < 0::numeric)',
    });
    expect(
      compileRule(
        { type: 'range', column: 'ngay_dat', min: '2026-01-01', max: '2026-12-31' },
        columns,
      ),
    ).toMatchObject({
      fails: `(t."c_2" < DATE '2026-01-01' OR t."c_2" > DATE '2026-12-31')`,
    });
    expect(
      compileRule({ type: 'range', column: 'ngay_tt', max: '2026-12-31T23:59' }, columns),
    ).toMatchObject({
      fails: `(t."c_5" > TIMESTAMP '2026-12-31 23:59')`,
    });
    expect(() =>
      compileRule({ type: 'range', column: 'doanh_thu', min: '1; DROP' }, columns),
    ).toThrow(RuleDefinitionError);
    expect(() =>
      compileRule({ type: 'range', column: 'ngay_dat', min: '2026-13-01' }, columns),
    ).toThrow(/not a date/);
    expect(() => compileRule({ type: 'range', column: 'ma_don', min: 'a' }, columns)).toThrow(
      /number or date/,
    );
  });

  it('compiles consistency expressions; unknown is not a violation', () => {
    expect(compileRule({ type: 'expression', expr: 'ngay_tt >= ngay_dat' }, columns)).toMatchObject(
      {
        kind: 'row',
        fails: 'NOT coalesce((t."c_5" >= t."c_2"), true)',
      },
    );
    expect(() => compileRule({ type: 'expression', expr: 'doanh_thu * 2' }, columns)).toThrow(
      /must produce boolean/,
    );
    expect(() => compileRule({ type: 'expression', expr: 'khong_co > 1' }, columns)).toThrow(
      /Unknown column/,
    );
  });

  it('groups for uniqueness and duplicates', () => {
    expect(compileRule({ type: 'unique', columns: ['ma_don', 'ngay_dat'] }, columns)).toMatchObject(
      {
        kind: 'groups',
        keySql: ['t."c_1"', 't."c_2"'],
      },
    );
    const dup = compileRule({ type: 'duplicate_rows' }, columns);
    expect(dup).toMatchObject({ kind: 'groups' });
    expect(dup.kind === 'groups' && dup.keySql[0]).toContain(
      'md5(row(t."c_1", t."c_2", t."c_3", t."c_4", t."c_5")::text)',
    );
  });

  it('rejects rules that do not fit the column', () => {
    expect(() => compileRule({ type: 'not_null', column: 'khong_co' }, columns)).toThrow(
      /does not exist/,
    );
    expect(() =>
      compileRule({ type: 'regex', column: 'doanh_thu', pattern: 'x' }, columns),
    ).toThrow(/text columns/);
    expect(() =>
      compileRule({ type: 'length', column: 'ma_don', min: 5, max: 2 }, columns),
    ).toThrow(/min must not/);
    expect(() => compileRule({ type: 'type_castable', column: 'ma_don' }, columns)).toThrow(
      /Text columns/,
    );
  });
});

describe('scoring', () => {
  const base = { weight: 1, threshold: 1, status: 'PASSED' as const };

  it('applies thresholds', () => {
    expect(ruleStatus(100, 0, 1)).toBe('PASSED');
    expect(ruleStatus(100, 1, 1)).toBe('FAILED');
    expect(ruleStatus(100, 5, 0.95)).toBe('PASSED');
    expect(ruleStatus(0, 0, 1)).toBe('PASSED');
  });

  it('weights by severity within a dimension and averages dimensions', () => {
    const result = computeScore([
      {
        ...base,
        dimension: 'completeness',
        severity: 'error',
        evaluated: 100,
        failed: 10,
        status: 'FAILED',
      },
      { ...base, dimension: 'completeness', severity: 'info', evaluated: 100, failed: 0 },
      { ...base, dimension: 'validity', severity: 'warning', evaluated: 50, failed: 0 },
    ]);
    // completeness: (2*0.9 + 0.5*1) / 2.5 = 0.92 → 92; validity 100; overall 96
    expect(result).toEqual({
      score: 96,
      dimensionScores: { completeness: 92, validity: 100 },
      qualityStatus: 'FAILED',
      rulesFailed: 1,
    });
  });

  it('a failing warning rule gives WARNING, skipped rules do not count', () => {
    expect(
      computeScore([
        {
          ...base,
          dimension: 'consistency',
          severity: 'warning',
          evaluated: 10,
          failed: 1,
          status: 'FAILED',
        },
        {
          ...base,
          dimension: 'uniqueness',
          severity: 'error',
          evaluated: 0,
          failed: 0,
          status: 'SKIPPED',
        },
      ]),
    ).toMatchObject({ score: 90, qualityStatus: 'WARNING', rulesFailed: 1 });
    expect(computeScore([])).toMatchObject({ score: null, qualityStatus: 'PASSED' });
  });
});
