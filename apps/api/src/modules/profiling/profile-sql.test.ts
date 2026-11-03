import { describe, expect, it } from 'vitest';
import {
  basicStatsQuery,
  distributionQuery,
  histogramBounds,
  sampleSource,
  SAMPLE_THRESHOLD,
} from './profile-sql';

describe('profiling SQL', () => {
  it('samples only large tables, repeatably', () => {
    expect(sampleSource('"v_t"', SAMPLE_THRESHOLD)).toEqual({ from: '"v_t"', sampled: false });
    expect(sampleSource('"v_t"', 2_000_000)).toEqual({
      from: '"v_t" TABLESAMPLE SYSTEM (25.00) REPEATABLE (42)',
      sampled: true,
    });
    expect(sampleSource('"v_t"', 10_000_000_000).from).toContain('SYSTEM (1.00)');
  });

  it('computes type-appropriate statistics in one scan', () => {
    const sql = basicStatsQuery('"v_t"', [
      { ident: '"c_1"', dataType: 'TEXT' },
      { ident: '"c_2"', dataType: 'DECIMAL' },
      { ident: '"c_3"', dataType: 'BOOLEAN' },
    ]);
    expect(sql).toMatch(/^SELECT count\(\*\) AS total, /);
    expect(sql).toContain('max(length("c_1")) AS lmax0');
    expect(sql).not.toContain('min("c_1")'); // lexical min/max of text is not useful
    expect(sql).toContain('trim_scale(round((stddev_samp("c_2"))::numeric, 6))::text AS sd1');
    expect(sql).not.toContain('min("c_3")');
    expect(sql.match(/ FROM /g)).toHaveLength(1);
  });

  it('adds quartiles only for numbers', () => {
    const sql = distributionQuery('"v_t"', [
      { ident: '"c_1"', dataType: 'INTEGER' },
      { ident: '"c_2"', dataType: 'DATE' },
    ]);
    expect(sql).toContain('percentile_cont(0.5) WITHIN GROUP (ORDER BY "c_1")');
    expect(sql).not.toContain('ORDER BY "c_2"');
    expect(sql).toContain('count(DISTINCT "c_2") AS d1');
  });

  it('builds histogram buckets that end exactly at the maximum', () => {
    const bounds = histogramBounds('0', '100', 4);
    expect(bounds).toEqual([
      { from: '0', to: '25' },
      { from: '25', to: '50' },
      { from: '50', to: '75' },
      { from: '75', to: '100' },
    ]);
    expect(histogramBounds('5', '5')).toEqual([{ from: '5', to: '5' }]);
  });
});
