import type { Catalog, QueryColumn, SemanticQueryResult } from '@insightai/contracts';
import { describe, expect, it } from 'vitest';
import { searchCatalog, TOOL_DEFINITIONS } from './ai-tools';
import {
  chartFor,
  cleanChatText,
  cleanFreeText,
  computeStats,
  fallbackNarrative,
  formatValue,
  interpretedAs,
  renderNarrative,
} from './answer-text';

const col = (key: string, extra: Partial<QueryColumn>): QueryColumn => ({
  key,
  name: key,
  kind: 'metric',
  granularity: null,
  type: 'DECIMAL',
  comparison: false,
  unit: null,
  format: null,
  ...extra,
});

const result = (
  columns: QueryColumn[],
  rows: (string | null)[][],
  extra: Partial<SemanticQueryResult> = {},
): SemanticQueryResult => ({
  columns,
  rows,
  truncated: false,
  dateRange: null,
  compareRange: null,
  metrics: [],
  modelRevision: 1,
  queryHistoryId: null,
  cached: false,
  policiesApplied: [],
  ...extra,
});

const revenue = col('revenue', { name: 'Doanh thu', unit: 'VND', format: 'currency' });
const region = col('customer.region', { name: 'Vùng', kind: 'dimension', type: 'TEXT' });
const byRegion = result(
  [region, revenue],
  [
    ['North', '150'],
    ['South', '1200.5'],
  ],
);

describe('formatValue', () => {
  it('formats exact decimals by locale, unit and format', () => {
    expect(formatValue('1234567.891', revenue, 'vi')).toBe('1.234.567,89 VND');
    expect(formatValue('1234567.891', revenue, 'en')).toBe('1,234,567.89 VND');
    expect(formatValue('0.125', col('rate', { format: 'percent' }), 'vi')).toBe('12,5%');
    expect(formatValue('2026-10-05', col('d', { type: 'DATE', kind: 'time' }), 'vi')).toBe(
      '05/10/2026',
    );
    expect(formatValue(null, revenue, 'en')).toBe('no data');
  });
});

describe('renderNarrative', () => {
  const stats = computeStats(byRegion, 'vi');

  it('fills cell and stat placeholders', () => {
    expect(stats.get('total:revenue')).toBe('1.350,5 VND');
    expect(
      renderNarrative(
        '{{cell:1.customer.region}} dẫn đầu với {{cell:1.revenue}}; tổng {{stat:total:revenue}}.',
        byRegion,
        stats,
        'vi',
      ),
    ).toBe('South dẫn đầu với 1.200,5 VND; tổng 1.350,5 VND.');
  });

  it('does not repeat a unit the model wrote after the placeholder', () => {
    expect(renderNarrative('Doanh thu {{cell:1.revenue}} VND.', byRegion, stats, 'vi')).toBe(
      'Doanh thu 1.200,5 VND.',
    );
    expect(renderNarrative('Tổng {{stat:total:revenue}} vnd', byRegion, stats, 'vi')).toBe(
      'Tổng 1.350,5 vnd',
    );
    expect(renderNarrative('{{cell:1.revenue}} VNDs', byRegion, stats, 'vi')).toBe(
      '1.200,5 VND VNDs',
    );
  });

  it('rejects numbers the model wrote itself and unknown references', () => {
    expect(renderNarrative('Doanh thu là 1.200 VND.', byRegion, stats, 'vi')).toBeNull();
    expect(renderNarrative('Tăng {{stat:nope}}.', byRegion, stats, 'vi')).toBeNull();
    expect(renderNarrative('{{cell:9.revenue}}', byRegion, stats, 'vi')).toBeNull();
    expect(renderNarrative('{{cell:0.secret}}', byRegion, stats, 'vi')).toBeNull();
    expect(renderNarrative('   ', byRegion, stats, 'vi')).toBeNull();
  });

  it('exposes the change against the previous period', () => {
    const kpi = result(
      [revenue, col('revenue', { ...revenue, comparison: true })],
      [['150', '100']],
    );
    const s = computeStats(kpi, 'en');
    expect(s.get('change:revenue')).toBe('+50%');
    expect(
      renderNarrative(
        '{{cell:0.revenue}} vs {{cell:0.revenue:previous}} ({{stat:change:revenue}}).',
        kpi,
        s,
        'en',
      ),
    ).toBe('150 VND vs 100 VND (+50%).');
    expect(fallbackNarrative(kpi, 'vi')).toBe(
      'Doanh thu: 150 VND (kỳ trước 100 VND, thay đổi +50%).',
    );
  });
});

describe('cleanFreeText', () => {
  it('keeps plain text and rejects figures in any script and links', () => {
    expect(cleanFreeText('  Bạn muốn xem khu vực nào?  ')).toBe('Bạn muốn xem khu vực nào?');
    expect(cleanFreeText('Doanh thu là 999 triệu')).toBeNull();
    expect(cleanFreeText('Doanh thu ９９')).toBeNull(); // full-width digits
    expect(cleanFreeText('Xem tại https://x.io')).toBeNull();
    expect(cleanFreeText('Xem tại evil.com')).toBeNull();
    expect(cleanFreeText('')).toBeNull();
  });
});

describe('fallbackNarrative and chartFor', () => {
  it('summarizes deterministically', () => {
    expect(fallbackNarrative(byRegion, 'vi')).toBe(
      'Kết quả có 2 dòng theo Vùng. Cao nhất về Doanh thu: South (1.200,5 VND).',
    );
    expect(fallbackNarrative(result([revenue], []), 'en')).toBe('No matching data.');
  });

  it('picks the chart from the shape of the result', () => {
    expect(chartFor(byRegion)).toEqual({ type: 'bar', x: 'customer.region', series: ['revenue'] });
    expect(chartFor(result([revenue], [['1']]))).toEqual({
      type: 'kpi',
      x: null,
      series: ['revenue'],
    });
    const month = col('order.date', { kind: 'time', type: 'DATE', granularity: 'month' });
    expect(chartFor(result([month, revenue], [['2026-10-01', '1']]))).toEqual({
      type: 'line',
      x: 'order.date',
      series: ['revenue'],
    });
    expect(chartFor(result([region, month, revenue], []))).toMatchObject({ type: 'table' });
  });

  it('describes how the question was understood', () => {
    const r = { ...byRegion, dateRange: { from: '2026-10-01', to: '2026-10-31' } };
    const q = {
      model: 'sales',
      metrics: ['revenue'],
      measures: [],
      dimensions: ['customer.region'],
      filters: [],
      orderBy: [],
      limit: 50,
    };
    expect(interpretedAs(q, r, new Map([['revenue', 'Doanh thu']]), 'vi')).toBe(
      'Doanh thu · theo Vùng · 01/10/2026 – 31/10/2026',
    );
  });
});

describe('tools', () => {
  const catalog: Catalog = {
    model: { key: 'sales', name: 'Sales', revision: 1 },
    metrics: [
      {
        key: 'paid_revenue',
        label: 'Doanh thu đã thanh toán',
        businessDefinition: null,
        unit: 'VND',
        format: 'currency',
        type: 'SIMPLE',
        version: 1,
        timeDimension: null,
        synonyms: ['doanh số'],
        additive: true,
        ratio: null,
      },
      {
        key: 'order_count',
        label: 'Số đơn',
        businessDefinition: null,
        unit: null,
        format: 'number',
        type: 'SIMPLE',
        version: 1,
        timeDimension: null,
        synonyms: [],
        additive: true,
        ratio: null,
      },
    ],
    dimensions: [
      {
        key: 'customer.region',
        name: 'Khu vực',
        description: null,
        type: 'CATEGORICAL',
        granularities: [],
        synonyms: ['vùng'],
      },
    ],
  };

  it('finds members by words and synonyms without accents', () => {
    const found = searchCatalog(catalog, 'Doanh so theo vung');
    expect(found.metrics.map((m) => m.key)).toEqual(['paid_revenue', 'order_count']);
    expect(found.dimensions.map((d) => d.key)).toEqual(['customer.region']);
  });

  it('describes every tool with a JSON schema', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      'search_catalog',
      'get_dimension_values',
      'run_semantic_query',
      'ask_clarification',
      'cannot_answer',
      'reply',
    ]);
    expect(TOOL_DEFINITIONS.find((t) => t.name === 'run_semantic_query')?.parameters).toMatchObject(
      {
        type: 'object',
        required: ['metrics'],
      },
    );
  });
});

describe('cleanChatText (D-62)', () => {
  const shown = new Set(['1.234.500', '12', '2026']);

  it('keeps replies without numbers or with numbers already shown', () => {
    expect(cleanChatText(' Xin chào! Bạn muốn xem doanh thu không? ', shown)).toBe(
      'Xin chào! Bạn muốn xem doanh thu không?',
    );
    expect(
      cleanChatText('Doanh thu 1.234.500 VND giảm 12% so với kỳ trước.', shown),
    ).not.toBeNull();
  });

  it('rejects numbers the user has not seen, other digit scripts and links', () => {
    expect(cleanChatText('Doanh thu khoảng 1.300.000 VND.', shown)).toBeNull();
    expect(cleanChatText('Tăng ١٢ phần trăm.', shown)).toBeNull();
    expect(cleanChatText('Xem thêm tại https://example.com', shown)).toBeNull();
    expect(cleanChatText('  ', shown)).toBeNull();
  });
});
