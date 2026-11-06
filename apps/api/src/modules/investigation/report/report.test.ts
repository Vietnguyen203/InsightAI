import type { Evidence, Finding, QueryColumn, SemanticQueryResult } from '@insightai/contracts';
import { describe, expect, it } from 'vitest';
import type { ToolOutput } from '../analysis-tools.service';
import { detectAnomalies } from '../analysis/anomaly';
import { compareValues } from '../analysis/comparison';
import { contribution, ratioDecomposition } from '../analysis/contribution';
import { distribution } from '../analysis/distribution';
import { trend } from '../analysis/trend';
import { evidenceValues, outputLimitations } from '../validation/evidence-values';
import { deriveFindings } from '../validation/findings';
import { buildReport, promptContext, type ReportDraft, type ReportInput } from './build-report';
import { findingText, formatFigure, renderGuarded } from './report-text';

const uuid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const column = (over: Partial<QueryColumn>): QueryColumn => ({
  key: 'revenue',
  name: 'Doanh thu',
  kind: 'metric',
  comparison: false,
  unit: 'đ',
  format: 'currency',
  granularity: null,
  type: 'DECIMAL',
  ...over,
});
const result = (rows: (string | null)[][], columns: QueryColumn[]): SemanticQueryResult => ({
  columns,
  rows,
  truncated: false,
  dateRange: null,
  compareRange: null,
  metrics: [{ key: 'revenue', version: 1 }],
  modelRevision: 1,
  queryHistoryId: null,
  cached: false,
  policiesApplied: [],
});
const byRegion = result(
  [
    ['North', '50'],
    ['South', '195'],
  ],
  [
    column({
      key: 'customer.region',
      name: 'Region',
      kind: 'dimension',
      unit: null,
      format: null,
      type: 'TEXT',
    }),
    column({}),
  ],
);

let next = 1;
/** Evidence and findings exactly as the engines and the validation phase produce them. */
function stepOf(output: ToolOutput, limitations: string[] = []) {
  const id = uuid(next++);
  const evidence: Evidence = {
    id,
    stepKey: `s${next}`,
    kind: output.tool,
    queries: [{ model: 'sales', metrics: ['revenue'] }] as unknown as Evidence['queries'],
    queryHistoryIds: [],
    versions: {
      modelRevision: 1,
      metrics: [{ key: 'revenue', version: 1 }],
      datasets: [{ id: uuid(900), name: 'orders', versionNo: 2, qualityScore: 96.4 }],
    },
    policiesApplied: [],
    results: [byRegion],
    values: evidenceValues(output),
    limitations: [...new Set([...outputLimitations(output), ...limitations])],
    createdAt: '2026-11-06T00:00:00.000Z',
  };
  const findings: Finding[] = deriveFindings(output, id, evidence.limitations).map((f) => ({
    ...f,
    id: uuid(next++),
  }));
  return { evidence, findings };
}

const drop = stepOf({
  tool: 'contribution',
  kind: 'additive',
  contribution: contribution([
    { member: 'North', current: '50', baseline: '120' },
    { member: 'South', current: '195', baseline: '200' },
    { member: 'Central', current: '40', baseline: '45' },
  ]),
});
const change = stepOf({
  tool: 'compare_periods',
  comparisons: [compareValues('revenue', '285', '365')],
});

const inputOf = (...steps: ReturnType<typeof stepOf>[]): ReportInput => ({
  investigationId: uuid(1000),
  goal: 'Why did revenue fall?',
  status: 'COMPLETED',
  errorCode: null,
  steps: [],
  evidence: steps.map((s) => s.evidence),
  findings: steps.flatMap((s) => s.findings).sort((a, b) => b.importance - a.importance),
  hypotheses: [],
});

const textOf = (segments: { text: string }[] | null | undefined) =>
  segments?.map((s) => s.text).join('') ?? null;

// ─── Guard ───────────────────────────────────────────────────────────────────

describe('renderGuarded', () => {
  const resolve = (kind: 'ev' | 'finding', alias: string, name: string) => {
    if (kind === 'ev' && alias === 'e1' && name in drop.evidence.values)
      return { type: 'value' as const, text: `<${name}>`, evidenceId: drop.evidence.id, name };
    if (kind === 'finding' && alias === 'f1' && name === 'member')
      return { type: 'value' as const, text: 'Store 12', evidenceId: drop.evidence.id, name };
    return undefined;
  };

  it.each([
    ['plain wording', 'Doanh thu giảm chủ yếu ở miền Bắc.', 'Doanh thu giảm chủ yếu ở miền Bắc.'],
    ['an evidence figure', 'Tổng giảm {{ev:e1.total.delta}}.', 'Tổng giảm <total.delta>.'],
    ['a finding parameter', 'Nổi bật: {{finding:f1.member}}.', 'Nổi bật: Store 12.'],
    ['spaces inside a placeholder', 'Tổng {{ ev : e1.total.delta }}.', 'Tổng <total.delta>.'],
    ['a nested figure name', 'Top {{ev:e1.top.0.share}}', 'Top <top.0.share>'],
    ['digits inside a resolved value', '{{finding:f1.member}} dẫn đầu', 'Store 12 dẫn đầu'],
  ])('accepts %s', (_name, text, expected) => {
    expect(textOf(renderGuarded(text, 500, resolve))).toBe(expected);
  });

  it.each([
    ['an ASCII digit', 'Doanh thu giảm 12%.'],
    ['a digit next to a placeholder', 'Giảm {{ev:e1.total.delta}} trong 3 tuần.'],
    ['a full-width digit', 'Doanh thu giảm ５ lần.'],
    ['an Arabic-Indic digit', 'Doanh thu giảm ٣ lần.'],
    ['a Devanagari digit', 'Doanh thu giảm ३ lần.'],
    ['a Thai digit', 'Doanh thu giảm ๓ lần.'],
    ['an http link', 'Xem https://evil.example/x'],
    ['a www link', 'Xem www.evil'],
    ['a bare domain', 'Xem tại insight.vn'],
    ['an unknown evidence alias', 'Tổng {{ev:e9.total.delta}}'],
    ['an unknown figure name', 'Tổng {{ev:e1.profit}}'],
    ['an unknown finding parameter', '{{finding:f1.delta}}'],
    ['a placeholder of the Q&A kind', '{{cell:0.revenue}}'],
    ['a placeholder without a name', '{{ev:e1}}'],
    ['a single brace', 'Giá trị {x}'],
    ['a stray closing brace', 'Giá trị }}'],
    ['empty text', '   '],
    ['text that is too long', 'a'.repeat(501)],
  ])('rejects %s', (_name, text) => {
    expect(renderGuarded(text, 500, resolve)).toBeNull();
  });
});

// ─── Figures ─────────────────────────────────────────────────────────────────

describe('formatFigure', () => {
  const e = drop.evidence;
  it.each([
    ['delta', '-70', 'vi', '-70 đ'],
    ['delta', '15.5', 'en', '+15.5 đ'],
    ['deltaRatio', -0.2192, 'vi', '-21,9%'],
    ['deltaRatio', 0.1, 'en', '+10%'],
    ['share', 0.875, 'en', '87.5%'],
    ['period', '2026-10-20', 'vi', '20/10/2026'],
    ['direction', 'down', 'vi', 'giảm'],
    ['metric', 'revenue', 'en', 'Doanh thu'],
    ['members', 3, 'en', '3'],
    ['z', 4.123456, 'en', '4.12'],
    ['delta', null, 'vi', 'không có dữ liệu'],
  ] as const)('%s %s (%s) → %s', (field, value, lang, expected) => {
    expect(formatFigure(field, value, e, 'revenue', lang)).toBe(expected);
  });
});

// ─── Deterministic sentences ─────────────────────────────────────────────────

const noise = [100, 102, 98, 101, 99, 103, 97, 100, 102, 98, 101, 99, 100, 101, 99, 100];
const daily = (values: number[]) =>
  values.map((v, i) => ({ period: `2026-01-${String(i + 1).padStart(2, '0')}`, value: String(v) }));
const months = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'];

describe('findingText', () => {
  const spiked = [...noise];
  spiked[7] = 400;
  const dipped = [...noise];
  dipped[3] = 10;
  const outputs: ToolOutput[] = [
    {
      tool: 'contribution',
      kind: 'additive',
      contribution: contribution([
        { member: 'North', current: '50', baseline: '120' },
        { member: 'South', current: '195', baseline: '200' },
      ]),
    },
    {
      tool: 'contribution',
      kind: 'additive',
      contribution: contribution([
        { member: 'North', current: '130', baseline: '100' },
        { member: 'South', current: '100', baseline: '200' },
        { member: 'Central', current: '160', baseline: '80' },
      ]),
    },
    {
      tool: 'contribution',
      kind: 'ratio',
      decomposition: ratioDecomposition([
        {
          member: 'North',
          numerator: { current: '400', baseline: '200' },
          denominator: { current: '20', baseline: '10' },
        },
        {
          member: 'South',
          numerator: { current: '100', baseline: '100' },
          denominator: { current: '10', baseline: '10' },
        },
      ]),
    },
    {
      tool: 'contribution',
      kind: 'ratio',
      decomposition: ratioDecomposition([
        {
          member: 'North',
          numerator: { current: '200', baseline: '100' },
          denominator: { current: '10', baseline: '10' },
        },
        {
          member: 'South',
          numerator: { current: '100', baseline: '100' },
          denominator: { current: '10', baseline: '10' },
        },
      ]),
    },
    { tool: 'compare_periods', comparisons: [compareValues('revenue', '80', '100')] },
    { tool: 'compare_periods', comparisons: [compareValues('revenue', '130', '100')] },
    { tool: 'compare_periods', comparisons: [compareValues('revenue', '100', '100')] },
    {
      tool: 'trend',
      trends: [
        trend(
          ['100', '110', '120', '130', '140', '150'].map((value, i) => ({
            period: months[i]!,
            value,
          })),
          'month',
          { metric: 'revenue' },
        ),
      ],
    },
    {
      tool: 'trend',
      trends: [
        trend(
          ['150', '140', '130', '120', '110', '100'].map((value, i) => ({
            period: months[i]!,
            value,
          })),
          'month',
          { metric: 'revenue' },
        ),
      ],
    },
    {
      tool: 'distribution',
      distribution: distribution([
        { member: 'A', value: '90' },
        { member: 'B', value: '10' },
      ]),
    },
    {
      tool: 'distribution',
      distribution: distribution([
        { member: 'A', value: '30' },
        { member: 'B', value: '30' },
        { member: 'C', value: '40' },
      ]),
    },
    { tool: 'anomaly', reports: [detectAnomalies(daily(spiked), { member: 'North' })] },
    { tool: 'anomaly', reports: [detectAnomalies(daily(dipped), { member: null })] },
    { tool: 'metric_snapshot', result: byRegion },
  ];

  const keys = new Set<string>();
  for (const output of outputs) {
    const { evidence, findings } = stepOf(output);
    for (const f of findings) {
      keys.add(f.templateKey);
      it(`fills every parameter of ${f.templateKey} (vi and en)`, () => {
        for (const lang of ['vi', 'en'] as const) {
          const text = findingText(f, evidence, lang);
          expect(textOf(text.segments)).not.toMatch(/—|\{|\}|undefined|NaN/);
          // Every figure is tied to the evidence it comes from.
          expect(
            text.segments
              .filter((s) => s.type === 'value')
              .every((s) => s.evidenceId === evidence.id),
          ).toBe(true);
        }
      });
    }
  }

  it('covers every template the validation phase produces', () => {
    expect([...keys].sort()).toEqual(
      [
        'anomaly.high',
        'anomaly.low',
        'concentration.high',
        'concentration.spread',
        'driver.opposite_direction',
        'driver.same_direction',
        'metric_change.down',
        'metric_change.flat',
        'metric_change.up',
        'ratio_driver.mix',
        'ratio_driver.rate',
        'snapshot',
        'trend.down',
        'trend.up',
      ].sort(),
    );
  });

  it('reads as expected and names the series of the whole metric', () => {
    expect(textOf(findingText(drop.findings[0]!, drop.evidence, 'vi').segments)).toBe(
      'North đóng góp nhiều nhất vào thay đổi: -70 đ, tức 87,5% trong tổng thay đổi -80 đ.',
    );
    // The sentence says the direction: the figures carry no sign of their own.
    expect(textOf(findingText(change.findings[0]!, change.evidence, 'vi').segments)).toBe(
      'Doanh thu giảm 80 đ (21,9%) so với kỳ so sánh.',
    );
    const overall = stepOf(outputs[12]!);
    expect(textOf(findingText(overall.findings[0]!, overall.evidence, 'en').segments)).toContain(
      'Unusually low value for overall on 01/04/2026',
    );
  });

  it('marks unverified findings', () => {
    const f = { ...change.findings[0]!, verified: false };
    expect(textOf(findingText(f, change.evidence, 'vi').segments)).toMatch(/\(chưa kiểm chứng\)$/);
  });
});

// ─── Report ──────────────────────────────────────────────────────────────────

describe('buildReport', () => {
  const input = inputOf(drop, change);
  const draft = (over: Partial<ReportDraft>): ReportDraft => ({
    summary: 'Doanh thu giảm {{ev:e2.revenue.delta}}, chủ yếu do {{finding:f1.member}}.',
    findings: [],
    recommendations: [],
    ...over,
  });

  it('is fully deterministic without a draft, every figure tied to evidence', () => {
    const report = buildReport(input, null, 'vi');
    expect(report.renderer).toBe('deterministic');
    expect(report.summary.source).toBe('template');
    expect(textOf(report.summary.segments)).toMatch(/^Phát hiện chính: North/);
    expect(report.findings.map((f) => f.text.source)).toEqual(['template', 'template']);
    const ids = new Set(input.evidence.map((e) => e.id));
    const values = [report.summary, ...report.findings.map((f) => f.text)].flatMap((p) =>
      p.segments.filter((s) => s.type === 'value'),
    );
    expect(values.length).toBeGreaterThan(4);
    expect(values.every((s) => ids.has(s.evidenceId))).toBe(true);
    // Charts are drawn from the frozen result, never re-run.
    expect(report.findings[0]!.chart).toEqual({
      evidenceId: drop.evidence.id,
      resultIndex: 0,
      spec: { type: 'bar', x: 'customer.region', series: ['revenue'] },
    });
    expect(report.recommendations).toEqual([]);
  });

  it('uses the LLM wording that passes the guard, filled from the evidence', () => {
    const report = buildReport(input, draft({}), 'vi');
    expect(report.renderer).toBe('llm');
    expect(textOf(report.summary.segments)).toBe('Doanh thu giảm -80 đ, chủ yếu do North.');
    expect(report.summary.segments[1]).toMatchObject({
      type: 'value',
      evidenceId: change.evidence.id,
      name: 'revenue.delta',
    });
  });

  it('replaces only the rejected parts with the templates', () => {
    const report = buildReport(
      input,
      draft({
        summary: 'Doanh thu giảm 80 đồng.',
        findings: [
          { finding: 'f1', text: '{{finding:f1.member}} kéo tổng xuống.' },
          { finding: 'f2', text: 'Giảm 22% so với tháng trước.' },
        ],
      }),
      'vi',
    );
    expect(report.summary.source).toBe('template');
    expect(report.findings.map((f) => f.text.source)).toEqual(['llm', 'template']);
    expect(textOf(report.findings[0]!.text.segments)).toBe('North kéo tổng xuống.');
    expect(report.renderer).toBe('llm');
  });

  it('keeps recommendations tied to known findings, at most three, labelled by the UI', () => {
    const rec = (text: string, findings: string[]) => ({ text, findings });
    const report = buildReport(
      input,
      draft({
        recommendations: [
          rec('Kiểm tra kênh bán ở {{finding:f1.member}}.', ['f1']),
          rec('Không gắn phát hiện nào.', ['f9']),
          rec('Có số 5 trong câu.', ['f1']),
          rec('Rà soát giá bán.', ['f1', 'f2']),
          rec('Theo dõi tồn kho.', ['f2']),
          rec('Thêm một gợi ý.', ['f2']),
        ],
      }),
      'vi',
    );
    expect(report.recommendations.map((r) => textOf(r.text.segments))).toEqual([
      'Kiểm tra kênh bán ở North.',
      'Rà soát giá bán.',
      'Theo dõi tồn kho.',
    ]);
    expect(report.recommendations[1]!.findingIds).toEqual(input.findings.map((f) => f.id));
  });

  it('never lets the LLM reword an unverified finding', () => {
    const unverified = {
      ...input,
      findings: input.findings.map((f) => ({ ...f, verified: false })),
    };
    const report = buildReport(
      unverified,
      draft({ findings: [{ finding: 'f1', text: 'Miền Bắc giảm mạnh.' }] }),
      'vi',
    );
    expect(report.findings[0]!.text.source).toBe('template');
  });

  it('says so when nothing was found', () => {
    const report = buildReport({ ...input, evidence: [], findings: [] }, null, 'en');
    expect(textOf(report.summary.segments)).toBe('No finding is backed by enough evidence.');
  });

  it('lists the limitations: partial run, steps that did not run, evidence, data quality', () => {
    const limited = stepOf(
      { tool: 'compare_periods', comparisons: [compareValues('revenue', '5', '0')] },
      ['TRUNCATED'],
    );
    const report = buildReport(
      {
        ...inputOf(drop, limited),
        status: 'PARTIAL',
        errorCode: 'BUDGET_EXCEEDED',
        steps: [
          { stepKey: 's3', purpose: 'Weekly trend', status: 'FAILED', errorCode: 'MEMBER_HIDDEN' },
          { stepKey: 's4', purpose: 'Anomalies', status: 'SKIPPED', errorCode: 'BUDGET_EXCEEDED' },
        ],
        hypotheses: [
          {
            key: 'h1',
            statement: 'North drives it',
            status: 'SUPPORTED',
            rule: { name: 'x', reason: 'y', thresholds: {}, observed: {} },
            evidenceIds: [drop.evidence.id],
          },
        ],
      },
      null,
      'vi',
    );
    expect(report.limitations.map((l) => l.code)).toEqual([
      'PARTIAL_RUN',
      'STEP_FAILED',
      'STEP_SKIPPED',
      'ZERO_BASELINE',
      'TRUNCATED',
      'DATA_QUALITY',
    ]);
    expect(report.limitations.find((l) => l.code === 'ZERO_BASELINE')!.evidenceIds).toEqual([
      limited.evidence.id,
    ]);
    expect(report.limitations.at(-1)!.text).toBe(
      'Bộ dữ liệu “orders” (phiên bản 2): điểm chất lượng 96/100.',
    );
    expect(report.hypotheses[0]!.label).toBe(
      'Có bằng chứng ủng hộ (tương quan, không chứng minh nhân quả)',
    );
  });
});

describe('promptContext', () => {
  const input = inputOf(drop, change);

  it('gives the LLM names only in METADATA_ONLY mode – no members, no figures', () => {
    const sent = JSON.stringify(promptContext(input, 'vi', false));
    expect(sent).not.toContain('North');
    expect(sent).not.toMatch(/-80|-70|0\.875/);
    expect(sent).toContain('total.delta');
    expect(sent).toContain('"id":"f1"');
  });

  it('adds the formatted figures when the organization shares data', () => {
    const sent = JSON.stringify(promptContext(input, 'en', true));
    expect(sent).toContain('North');
    expect(sent).toContain('-80 đ');
  });
});
