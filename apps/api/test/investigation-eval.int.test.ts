import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type {
  Evidence,
  ImportJob,
  InvestigationDetail,
  InvestigationReport,
  InvestigationStatus,
  SemanticModelDetail,
} from '@insightai/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAppConfig } from '../src/platform/config/config.module';
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '../src/modules/ai/llm-provider';
import { OpenAiProvider } from '../src/modules/ai/openai-provider';
import { PacedLlm, sample as sampleCases } from './eval/real-llm';
import { WorkerModule } from '../src/worker.module';
import {
  aovTruth,
  contributionTruth,
  csvFiles,
  generate,
  INJECTION_CITY,
  ORG_A,
  ORG_B,
  type SalesRow,
} from './eval/fixtures/sales-effects';
import {
  type EvalCase,
  type Group,
  INVESTIGATION_EVAL_SET,
  ORG_A_MEMBER_NAMES,
  ORG_B_MEMBER_NAMES,
  type Reply,
} from './eval/investigation-eval-set';
import { connectAdmin } from './support/admin-db';
import {
  cleanupTestData,
  client,
  createTestApp,
  registerUser,
  type TestUser,
} from './support/test-app';

/**
 * Investigation eval (opt-in), docs/PHASE6_AI_ANALYST_DESIGN.md §4 groups B–K.
 * - `AI_EVAL=oracle`: the model's replies are scripted per case (the ideal plan, a narrative,
 *   or deliberately bad output). Checks the fixture, the deterministic pipeline, the guards and
 *   the scoring without any API key – every case must pass.
 * - `AI_EVAL=true` with OPENAI_API_KEY/OPENAI_MODEL: the real model plans and writes; cases
 *   that script bad model output are skipped. Writes a report, does not fail on thresholds.
 * Report: AI_EVAL_INVESTIGATION_REPORT (default <tmp>/insightai-investigation-eval.json).
 */
const MODE = process.env.AI_EVAL;
const REAL = MODE === 'true';

/** Design thresholds (§4) per group, as a share of passing cases. */
const THRESHOLDS: Record<Group, number> = {
  B: 0.9,
  C: 0.85,
  D: 0.9,
  E: 1,
  F: 1,
  G: 0.8,
  H: 0.8,
  I: 0.8,
  J: 1,
  K: 1,
};

/**
 * Oracle cases that fail on purpose: the engine is measured against planted truth, and these
 * are its known misses. The oracle run must fail exactly these (a fix or a new miss both show).
 */
const KNOWN_ORACLE_FAILURES: Record<string, string> = {
  'I-september-anomaly':
    'median/MAD (z >= 3.5) flags one September day of TP.HCM (z -3.54) that is only noise',
};

// ─── Oracle model ───────────────────────────────────────────────────────────

const toResponse = (reply: Reply): LlmResponse => {
  const usage = { promptTokens: 0, completionTokens: 0 };
  if ('text' in reply) return { content: reply.text, toolCalls: [], usage };
  const calls = 'calls' in reply ? reply.calls : [reply];
  return {
    content: null,
    toolCalls: calls.map((c, i) => ({
      id: `oracle-${i}`,
      name: c.tool,
      arguments: JSON.stringify(c.args),
    })),
    usage,
  };
};

/** Replies with the current case's script; records every request (what the model was sent). */
class OracleLlm implements LlmProvider {
  readonly name = 'oracle';
  readonly model = 'oracle';
  planning: Reply[] = [];
  report: Reply | undefined;
  requests: LlmRequest[] = [];
  chat(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    const reporting = request.tools?.some((t) => t.name === 'write_report');
    const reply = reporting ? this.report : this.planning.shift();
    if (reporting) this.report = undefined;
    if (!reply) return Promise.reject(new Error('No scripted reply'));
    return Promise.resolve(toResponse(reply));
  }
}

/** Records what the real model was sent. */
class RecordingLlm implements LlmProvider {
  requests: LlmRequest[] = [];
  constructor(private readonly inner: LlmProvider) {}
  get name() {
    return this.inner.name;
  }
  get model() {
    return this.inner.model;
  }
  chat(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    return this.inner.chat(request);
  }
}

// ─── Checks ─────────────────────────────────────────────────────────────────

interface Run {
  detail: InvestigationDetail;
  evidence: Evidence[];
  report: InvestigationReport | null;
  requests: LlmRequest[];
  ms: number;
}

const DIGIT = /\p{Nd}/u;

/** Parses a figure as the report shows it in Vietnamese (1.234,5 · -21,9% · +80 đ). */
function parseFigure(text: string): { value: number; percent: boolean; decimals: number } | null {
  const match = /[+\-−]?[\d.]+(?:,\d+)?/.exec(text);
  if (!match) return null;
  const raw = match[0].replace('−', '-');
  const [int, frac = ''] = raw.split(',');
  const value = Number(`${int!.replaceAll('.', '')}${frac ? `.${frac}` : ''}`);
  return Number.isFinite(value)
    ? { value, percent: text.includes('%'), decimals: frac.length }
    : null;
}

/** Every figure of the report is a value segment that matches the evidence it points to. */
function traceViolations(run: Run): string[] {
  const report = run.report;
  if (!report) return [];
  const out: string[] = [];
  const byId = new Map(run.evidence.map((e) => [e.id, e]));
  const paragraphs = [
    report.summary,
    ...report.findings.map((f) => f.text),
    ...report.recommendations.map((r) => r.text),
  ];
  for (const p of paragraphs) {
    for (const s of p.segments) {
      if (s.type === 'text') {
        if (DIGIT.test(s.text)) out.push(`digit in text "${s.text.slice(0, 40)}"`);
        continue;
      }
      const evidence = byId.get(s.evidenceId);
      if (!evidence) {
        out.push(`segment points to unknown evidence ${s.evidenceId}`);
        continue;
      }
      const candidates = [
        ...(s.name in evidence.values ? [evidence.values[s.name]] : []),
        ...run.detail.findings
          .filter((f) => f.evidenceIds.includes(evidence.id) && s.name in f.params)
          .map((f) => f.params[s.name]),
      ];
      if (candidates.length === 0) {
        out.push(`"${s.name}" is neither a value nor a parameter of evidence ${evidence.stepKey}`);
        continue;
      }
      if (!candidates.some((v) => figureMatches(s.text, v ?? null))) {
        out.push(`"${s.text}" does not match ${s.name}=${JSON.stringify(candidates)}`);
      }
    }
  }
  return out;
}

function figureMatches(text: string, value: string | number | null): boolean {
  if (value === null) return text === 'không có dữ liệu' || text === 'tổng thể';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [y, m, d] = value.slice(0, 10).split('-');
    return text === `${d}/${m}/${y}`;
  }
  const number = Number(value);
  // Members are shown as they are; words (direction) and labels (metric) carry no figures.
  if (typeof value === 'string' && !Number.isFinite(number)) {
    return text === value || (text.length > 0 && !DIGIT.test(text));
  }
  const parsed = parseFigure(text);
  if (!parsed) return !DIGIT.test(text) && text.length > 0; // a label (metric name)
  const expected = Math.abs(parsed.percent ? number * 100 : number);
  const tolerance = 0.5 * 10 ** -parsed.decimals + 1e-9;
  return Math.abs(Math.abs(parsed.value) - expected) <= tolerance;
}

function check(c: EvalCase, run: Run, rows: SalesRow[]): string[] {
  const e = c.expect;
  const d = run.detail;
  const fail: string[] = [];
  if (e.status && !e.status.includes(d.status)) {
    fail.push(`status ${d.status} (${d.errorCode ?? ''}), expected ${e.status.join('|')}`);
  }
  if (e.errorCode !== undefined && d.errorCode !== e.errorCode) {
    fail.push(`errorCode ${d.errorCode}, expected ${e.errorCode}`);
  }
  if (e.errorMessage !== undefined && d.errorMessage !== e.errorMessage) {
    fail.push(`errorMessage ${JSON.stringify(d.errorMessage)}`);
  }
  if (e.planErrors && !REAL) {
    const told = run.requests
      .flatMap((r) => r.messages)
      .filter((m) => m.role === 'tool')
      .map((m) => m.content)
      .join(' ');
    for (const code of e.planErrors)
      if (!told.includes(code)) fail.push(`planner not told ${code}`);
  }
  if (e.tools) {
    const tools = new Set(d.plan?.steps.map((s) => s.tool) ?? []);
    for (const t of e.tools) if (!tools.has(t as never)) fail.push(`plan has no ${t} step`);
  }
  if (e.contribution) {
    const x = e.contribution;
    const step = d.plan?.steps.find(
      (s) => s.tool === 'contribution' && s.dimension === x.by && s.metric === x.metric,
    );
    const row = d.steps.find((s) => s.stepKey === step?.id);
    const output = row?.output as
      | {
          kind: string;
          contribution: { members: { member: string; delta: string }[]; totalDelta: string };
        }
      | undefined;
    if (!output || output.kind !== 'additive') {
      fail.push('no additive contribution output');
    } else {
      const truth = contributionTruth(rows, x.metric, x.by, x.current, x.baseline, x.filters);
      const c2 = output.contribution;
      if (!truth.top.includes(c2.members[0]?.member ?? '')) {
        fail.push(`top ${c2.members[0]?.member}, truth ${truth.top.join('|')}`);
      }
      if (Number(c2.totalDelta) !== truth.totalDelta) {
        fail.push(`total delta ${c2.totalDelta}, truth ${truth.totalDelta}`);
      }
      const sum = c2.members.reduce((a, m) => a + Number(m.delta), 0);
      if (Math.abs(sum - truth.totalDelta) > 1e-6) fail.push(`members sum ${sum} ≠ total`);
      for (const m of c2.members) {
        if (Number(m.delta) !== truth.deltas.get(m.member)) {
          fail.push(`${m.member} delta ${m.delta}, truth ${truth.deltas.get(m.member)}`);
        }
      }
    }
  }
  if (e.ratio) {
    const step = d.plan?.steps.find((s) => s.tool === 'contribution' && s.metric === 'aov');
    const out = d.steps.find((s) => s.stepKey === step?.id)?.output as
      | {
          kind: string;
          decomposition: { ratioCurrent: number | null; ratioBaseline: number | null };
        }
      | undefined;
    const now = aovTruth(rows, e.ratio.current);
    const before = aovTruth(rows, e.ratio.baseline);
    const close = (a: number | null | undefined, b: number | null) =>
      a !== null && a !== undefined && b !== null && Math.abs(a - b) <= Math.abs(b) * 1e-4;
    if (out?.kind !== 'ratio') fail.push('no ratio decomposition');
    else if (
      !close(out.decomposition.ratioCurrent, now) ||
      !close(out.decomposition.ratioBaseline, before)
    ) {
      fail.push(
        `aov ${out.decomposition.ratioCurrent}/${out.decomposition.ratioBaseline}, truth ${now}/${before}`,
      );
    }
  }
  if (e.hypotheses && !REAL) {
    for (const [key, status] of Object.entries(e.hypotheses)) {
      const h = d.hypotheses.find((x) => x.key === key);
      if (h?.status !== status) {
        fail.push(`${key} ${h?.status} (${h?.rule.reason}), expected ${status}`);
      }
    }
  }
  if (e.limitations) {
    const codes = new Set(run.evidence.flatMap((x) => x.limitations));
    for (const code of e.limitations) if (!codes.has(code)) fail.push(`no ${code} limitation`);
  }
  if (e.noVerifiedFindings && d.findings.some((f) => f.verified)) {
    fail.push('a finding is marked verified without data');
  }
  const r = run.report;
  if (!REAL) {
    if (e.renderer && r?.renderer !== e.renderer) fail.push(`renderer ${r?.renderer}`);
    if (e.sources?.summary && r?.summary.source !== e.sources.summary) {
      fail.push(`summary from ${r?.summary.source}`);
    }
    e.sources?.findings?.forEach((source, i) => {
      if (r?.findings[i]?.text.source !== source) {
        fail.push(`finding ${i + 1} from ${r?.findings[i]?.text.source}`);
      }
    });
    if (e.recommendations !== undefined && r?.recommendations.length !== e.recommendations) {
      fail.push(`${r?.recommendations.length} recommendations, expected ${e.recommendations}`);
    }
  }
  // Every report: figures traceable to evidence, causal-free hypothesis labels.
  fail.push(...traceViolations(run));
  for (const h of r?.hypotheses ?? []) {
    if (/\b(gây ra|do đó|nguyên nhân|vì vậy|caused?|because)\b/i.test(h.label)) {
      fail.push(`causal wording in "${h.label}"`);
    }
  }
  // Isolation: nothing of the other organization; the injection city never reaches the model.
  const shown = JSON.stringify([run.detail, run.evidence, run.report]);
  const foreign = (c.org === 'B' ? ORG_A_MEMBER_NAMES : ORG_B_MEMBER_NAMES).concat(e.absent ?? []);
  for (const name of new Set(foreign)) if (shown.includes(name)) fail.push(`shows "${name}"`);
  const sent = JSON.stringify(run.requests);
  for (const text of [INJECTION_CITY, ...(e.notSentToLlm ?? [])]) {
    if (sent.includes(text)) fail.push(`sent "${text.slice(0, 30)}…" to the model`);
  }
  return fail;
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe.runIf(MODE === 'true' || MODE === 'oracle')('Investigation eval set (opt-in)', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let admin: pg.Client;
  let ownerA: TestUser;
  let analystA: TestUser;
  let ownerB: TestUser;
  let orgA: string;
  let orgB: string;
  let llm: OracleLlm | RecordingLlm;
  const rows = { A: generate(ORG_A), B: generate(ORG_B) };

  beforeAll(async () => {
    process.env.INVESTIGATION_DAILY_LIMIT = '100000';
    process.env.INVESTIGATION_MAX_ACTIVE = '100';
    if (REAL) {
      const config = loadAppConfig();
      if (!config.OPENAI_API_KEY || !config.OPENAI_MODEL) {
        throw new Error('AI_EVAL=true needs OPENAI_API_KEY and OPENAI_MODEL');
      }
      // A paced run lasts longer than the default 15-minute access token.
      process.env.JWT_ACCESS_TTL_SECONDS = '3600';
      paced = new PacedLlm(
        new OpenAiProvider(config.OPENAI_API_KEY, config.OPENAI_MODEL, config.OPENAI_BASE_URL),
      );
      llm = new RecordingLlm(paced);
    } else {
      llm = new OracleLlm();
    }
    admin = await connectAdmin();
    app = await createTestApp({ llm });
    worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(llm)
      .compile();
    worker.useLogger(false);
    await worker.init();

    ownerA = await registerUser(app, { label: 'iv-eval-a', organizationName: 'Eval A' });
    orgA = ownerA.organizationId!;
    const invite = (
      await client(app)
        .post('/api/v1/invitations', ownerA, orgA)
        .send({ role: 'analyst' })
        .expect(201)
    ).body.token as string;
    analystA = await registerUser(app, { label: 'iv-eval-an', invitationToken: invite });
    ownerB = await registerUser(app, { label: 'iv-eval-b', organizationName: 'Eval B' });
    orgB = ownerB.organizationId!;
    await setUpOrganization(ownerA, orgA, csvFiles(ORG_A, rows.A));
    await setUpOrganization(ownerB, orgB, csvFiles(ORG_B, rows.B));
  }, 300_000);

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    if (admin) {
      await cleanupTestData(admin);
      await admin.end();
    }
  });

  async function setUpOrganization(user: TestUser, org: string, files: Record<string, string[]>) {
    const post = async <T>(path: string, body: object): Promise<T> => {
      const res = await client(app).post(`/api/v1${path}`, user, org).send(body);
      if (res.status >= 300) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body as T;
    };
    const datasets: Record<string, string> = {};
    for (const [name, lines] of Object.entries(files)) {
      const dataset = await post<{ id: string }>('/datasets', { name });
      const upload = await client(app)
        .post(`/api/v1/datasets/${dataset.id}/imports`, user, org)
        .attach('file', Buffer.from(`${lines.join('\n')}\n`), `${name}.csv`)
        .field('options', JSON.stringify({ locale: 'en' }));
      if (upload.status !== 202) throw new Error(`import ${name}: ${upload.status}`);
      for (let i = 0; i < 600; i++) {
        const job = (await client(app).get(`/api/v1/imports/${upload.body.id}`, user, org))
          .body as ImportJob;
        if (job.status === 'SUCCEEDED') break;
        if (job.status === 'FAILED') throw new Error(JSON.stringify(job.error));
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      datasets[name] = dataset.id;
    }
    let model = await post<SemanticModelDetail>('/semantic-models', {
      key: 'sales',
      name: 'Sales',
    });
    for (const [key, dataset, pk] of [
      ['order', 'orders', 'order_id'],
      ['customer', 'customers', 'customer_id'],
      ['product', 'products', 'product_id'],
    ] as const) {
      model = await post(`/semantic-models/${model.id}/entities`, {
        key,
        name: key,
        datasetId: datasets[dataset],
        primaryKey: [pk],
      });
    }
    const entity = (key: string) => model.entities.find((x) => x.key === key)!.id;
    for (const [owner, key, type, expr] of [
      ['order', 'order_date', 'TIME', 'created_at'],
      ['order', 'status', 'CATEGORICAL', 'status'],
      ['order', 'channel', 'CATEGORICAL', 'channel'],
      ['customer', 'city', 'CATEGORICAL', 'city'],
      ['customer', 'region', 'CATEGORICAL', 'region'],
      ['product', 'category', 'CATEGORICAL', 'category'],
    ] as const) {
      await post(`/semantic-entities/${entity(owner)}/dimensions`, { key, name: key, type, expr });
    }
    for (const [key, agg, expr] of [
      ['revenue', 'sum', 'amount'],
      ['orders', 'count', null],
      ['avg_amount', 'avg', 'amount'],
    ] as const) {
      await post(`/semantic-entities/${entity('order')}/measures`, {
        key,
        name: key,
        agg,
        ...(expr ? { expr } : {}),
      });
    }
    for (const to of ['customer', 'product']) {
      await post(`/semantic-models/${model.id}/relationships`, {
        fromEntityId: entity('order'),
        toEntityId: entity(to),
        joinColumns: [{ from: `${to}_id`, to: `${to}_id` }],
        cardinality: 'MANY_TO_ONE',
      });
    }
    await post(`/semantic-models/${model.id}/publish`, {});
    const paid = [{ member: 'order.status', op: 'eq', values: ['PAID'] }];
    for (const [key, label, definition] of [
      [
        'paid_revenue',
        'Doanh thu',
        {
          type: 'SIMPLE',
          measure: 'order.revenue',
          filters: paid,
          timeDimension: 'order.order_date',
        },
      ],
      [
        'paid_orders',
        'Số đơn',
        {
          type: 'SIMPLE',
          measure: 'order.orders',
          filters: paid,
          timeDimension: 'order.order_date',
        },
      ],
      [
        'avg_amount',
        'Giá trị trung bình',
        {
          type: 'SIMPLE',
          measure: 'order.avg_amount',
          filters: paid,
          timeDimension: 'order.order_date',
        },
      ],
      [
        'aov',
        'Giá trị đơn trung bình',
        { type: 'RATIO', numerator: 'paid_revenue', denominator: 'paid_orders' },
      ],
    ] as const) {
      const metric = await post<{ draft: { id: string } }>(`/semantic-models/${model.id}/metrics`, {
        key,
        label,
        definition,
      });
      await post(`/metric-versions/${metric.draft.id}/publish`, {});
    }
  }

  const ownerOf = (c: EvalCase): [TestUser, string] =>
    c.org === 'B' ? [ownerB, orgB] : [ownerA, orgA];
  const get = async (path: string, user: TestUser, org: string) =>
    client(app).get(`/api/v1${path}`, user, org);

  async function waitFor(id: string, user: TestUser, org: string, statuses: InvestigationStatus[]) {
    for (let i = 0; i < 1200; i++) {
      const res = await get(`/investigations/${id}`, user, org);
      const inv = res.body as InvestigationDetail;
      if (statuses.includes(inv.status)) return inv;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Investigation ${id} did not reach ${statuses.join('|')}`);
  }

  async function runCase(c: EvalCase): Promise<Run> {
    const [user, org] = ownerOf(c);
    if (llm instanceof OracleLlm) {
      llm.planning = [...c.oracle.planning];
      llm.report = c.oracle.report;
    }
    llm.requests = [];
    const started = Date.now();
    const pause = c.setup?.approvalOnly === true || c.setup?.budget !== undefined;
    const created = await client(app)
      .post('/api/v1/investigations', user, org)
      .send({ model: 'sales', goal: c.goal, requireApproval: pause });
    if (created.status !== 202) throw new Error(`${c.id}: create ${created.status}`);
    const id = (created.body as InvestigationDetail).id;
    const terminal: InvestigationStatus[] = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'];
    let detail: InvestigationDetail;
    if (pause) {
      detail = await waitFor(id, user, org, ['AWAITING_APPROVAL', ...terminal]);
      if (detail.status === 'AWAITING_APPROVAL' && !c.setup?.approvalOnly) {
        for (const [key, value] of Object.entries(c.setup?.budget ?? {})) {
          await admin.query(
            `UPDATE app.investigations SET budget = jsonb_set(budget, $2, $3::jsonb) WHERE id = $1`,
            [id, `{${key}}`, JSON.stringify(value)],
          );
        }
        await client(app).post(`/api/v1/investigations/${id}/approve`, user, org).expect(200);
        detail = await waitFor(id, user, org, terminal);
      }
    } else {
      detail = await waitFor(id, user, org, terminal);
    }
    const ms = Date.now() - started;
    const evidence = (await get(`/investigations/${id}/evidence`, user, org)).body as Evidence[];
    const reportRes = await get(`/investigations/${id}/report`, user, org);
    const run: Run = {
      detail,
      evidence,
      report: reportRes.status === 200 ? (reportRes.body as InvestigationReport) : null,
      requests: llm.requests,
      ms,
    };
    if (detail.status === 'AWAITING_APPROVAL') {
      await client(app).post(`/api/v1/investigations/${id}/cancel`, user, org).expect(200);
    }
    return run;
  }

  /** A finished investigation of org A with evidence, for the access checks. */
  let sample: { id: string; evidenceId: string } | null = null;

  async function accessCase(c: EvalCase): Promise<string[]> {
    if (!sample) return ['no investigation of org A to probe'];
    const path = `/investigations/${sample.id}`;
    let status: number;
    switch (c.access!) {
      case 'other-org-detail':
        status = (await get(path, ownerB, orgB)).status;
        break;
      case 'other-org-report':
        status = (await get(`${path}/report`, ownerB, orgB)).status;
        break;
      case 'other-org-evidence':
        status = (await get(`${path}/evidence`, ownerB, orgB)).status;
        break;
      case 'other-org-events':
        status = (await get(`${path}/events`, ownerB, orgB)).status;
        break;
      case 'other-org-pin': {
        const dashboard = await client(app)
          .post('/api/v1/dashboards', ownerB, orgB)
          .send({ name: 'Eval B' })
          .expect(201);
        status = (
          await client(app)
            .post(`/api/v1/dashboards/${dashboard.body.id}/widgets`, ownerB, orgB)
            .send({ fromEvidenceId: sample.evidenceId })
        ).status;
        break;
      }
      case 'same-org-other-user':
        status = (await get(`${path}/report`, analystA, orgA)).status;
        break;
      case 'same-org-other-user-list': {
        const list = (await get('/investigations', analystA, orgA)).body as { id: string }[];
        status = list.some((i) => i.id === sample!.id) ? 200 : 404;
        break;
      }
    }
    return status === c.expect.httpStatus
      ? []
      : [`HTTP ${status}, expected ${c.expect.httpStatus}`];
  }

  let paced: PacedLlm | undefined;

  it('runs the investigation eval set', async () => {
    const cases = sampleCases(
      INVESTIGATION_EVAL_SET.filter((c) => !(REAL && c.oracleOnly)),
      (c) => c.group,
    );
    const outcomes: {
      id: string;
      group: Group;
      pass: boolean;
      reasons: string[];
      status?: string;
      ms?: number;
      tokens?: number;
    }[] = [];
    for (const c of cases) {
      if (c.access) {
        const reasons = await accessCase(c);
        outcomes.push({ id: c.id, group: c.group, pass: reasons.length === 0, reasons });
        continue;
      }
      let reasons: string[];
      let run: Run | null = null;
      try {
        run = await runCase(c);
        reasons = check(c, run, c.org === 'B' ? rows.B : rows.A);
        if (!sample && c.org !== 'B' && run.report && run.evidence[0]) {
          sample = { id: run.detail.id, evidenceId: run.evidence[0].id };
        }
      } catch (error) {
        reasons = [`error: ${(error as Error).message}`];
      }
      outcomes.push({
        id: c.id,
        group: c.group,
        pass: reasons.length === 0,
        reasons,
        status: run?.detail.status,
        ms: run?.ms,
        tokens: run?.detail.usage.tokens,
      });
    }

    const groups = [...new Set(outcomes.map((o) => o.group))].sort();
    const byGroup = Object.fromEntries(
      groups.map((g) => {
        const items = outcomes.filter((o) => o.group === g);
        const passed = items.filter((o) => o.pass).length;
        return [
          g,
          {
            passed,
            total: items.length,
            accuracy: passed / items.length,
            threshold: THRESHOLDS[g],
            meetsThreshold: passed / items.length >= THRESHOLDS[g],
          },
        ];
      }),
    );
    const times = outcomes.flatMap((o) => (o.ms === undefined ? [] : [o.ms])).sort((a, b) => a - b);
    const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))] ?? 0;
    const report =
      process.env.AI_EVAL_INVESTIGATION_REPORT ??
      join(tmpdir(), 'insightai-investigation-eval.json');
    writeFileSync(
      report,
      JSON.stringify(
        {
          mode: MODE,
          model: llm.model,
          llm: paced?.stats() ?? null,
          sampled: cases.length,
          byGroup,
          runs: times.length,
          p50Ms: pct(0.5),
          p95Ms: pct(0.95),
          tokens: outcomes.reduce((a, o) => a + (o.tokens ?? 0), 0),
          knownOracleFailures: KNOWN_ORACLE_FAILURES,
          outcomes,
        },
        null,
        2,
      ),
    );
    const failed = outcomes.filter((o) => !o.pass);
    console.log(
      `Investigation eval (${MODE}): ${outcomes.length - failed.length}/${outcomes.length} → ${report}\n` +
        groups.map((g) => `  ${g}: ${byGroup[g]!.passed}/${byGroup[g]!.total}`).join('\n') +
        (failed.length
          ? `\nFailed:\n${failed.map((o) => `  ${o.id}: ${o.reasons.join('; ')}`).join('\n')}`
          : ''),
    );
    if (!REAL) {
      const unexpected = failed.filter((o) => !(o.id in KNOWN_ORACLE_FAILURES));
      expect(unexpected.map((o) => `${o.id}: ${o.reasons.join('; ')}`)).toEqual([]);
      expect(failed.map((o) => o.id).sort()).toEqual(Object.keys(KNOWN_ORACLE_FAILURES).sort());
    }
  }, 3_600_000);
});
