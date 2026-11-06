import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type {
  Evidence,
  ImportJob,
  InvestigationDetail,
  InvestigationStatus,
  MetricDetail,
  SemanticModelDetail,
} from '@insightai/contracts';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/modules/ai/llm-provider';
import { LLM_PROVIDER } from '../src/modules/ai/llm-provider';
import { AnalysisToolsService } from '../src/modules/investigation/analysis-tools.service';
import { InvestigationOrchestrator } from '../src/modules/investigation/orchestrator.service';
import { loadAppConfig } from '../src/platform/config/config.module';
import { WorkerModule } from '../src/worker.module';
import { connectAdmin } from './support/admin-db';
import {
  cleanupTestData,
  client,
  createTestApp,
  registerUser,
  type TestUser,
} from './support/test-app';

const ORDERS = ['order_id,customer_id,created_at,status,amount'];
for (let d = 1; d <= 30; d++) {
  const dd = String(d).padStart(2, '0');
  ORDERS.push(`S${d}a,C1,2026-09-${dd},PAID,${120 + (d % 4) * 2}`);
  ORDERS.push(`S${d}b,C2,2026-09-${dd},PAID,${40 + (d % 3)}`);
  ORDERS.push(`O${d}a,C1,2026-10-${dd},PAID,${100 + (d % 5) * 3 + (d === 20 ? 2000 : 0)}`);
  ORDERS.push(`O${d}b,C2,2026-10-${dd},PAID,${50 + (d % 3) * 2}`);
}
const CUSTOMERS = ['customer_id,region', 'C1,North', 'C2,South'];
const oct = { from: '2026-10-01', to: '2026-10-30' };
const sep = { from: '2026-09-01', to: '2026-09-30' };

/** A full, valid plan for the fixture (four steps, one hypothesis). */
const PLAN = {
  version: 1,
  goal: 'Explain the change of paid revenue in October',
  primaryMetric: 'paid_revenue',
  hypotheses: [
    {
      id: 'h1',
      statement: 'The North region drives the change',
      expectation: { kind: 'member_drives_change', stepId: 's2', member: 'North', direction: 'up' },
    },
  ],
  steps: [
    {
      id: 's1',
      tool: 'compare_periods',
      purpose: 'Overall change',
      metrics: ['paid_revenue'],
      current: oct,
      baseline: sep,
    },
    {
      id: 's2',
      tool: 'contribution',
      purpose: 'Which regions',
      metric: 'paid_revenue',
      dimension: 'customer.region',
      current: oct,
      baseline: sep,
    },
    {
      id: 's3',
      tool: 'trend',
      purpose: 'Weekly trend of the top region',
      metrics: ['paid_revenue'],
      granularity: 'week',
      period: oct,
      scope: { fromStep: 's2', pick: 'top_contributors', k: 1 },
    },
    {
      id: 's4',
      tool: 'anomaly',
      purpose: 'Unusual days by region',
      metric: 'paid_revenue',
      granularity: 'day',
      period: oct,
      dimension: 'customer.region',
    },
  ],
};

type Reply = (request: LlmRequest) => LlmResponse;
const call =
  (name: string, args: unknown): Reply =>
  () => ({
    content: null,
    toolCalls: [{ id: `c-${name}`, name, arguments: JSON.stringify(args) }],
    usage: { promptTokens: 1000, completionTokens: 200 },
  });

/** Scripted planner: replies are queued per goal. */
class ScriptedLlm implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-1';
  scripts = new Map<string, Reply[]>();
  requests: LlmRequest[] = [];
  chat(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    const goal =
      request.messages.find((m) => m.role === 'user')?.content?.replace('GOAL: ', '') ?? '';
    const reply = this.scripts.get(goal)?.shift();
    if (!reply) return Promise.reject(new Error(`No scripted reply for "${goal}"`));
    return Promise.resolve(reply(request));
  }
}

describe('investigations (integration, scripted planner, real worker)', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let admin: pg.Client;
  let owner: TestUser;
  let analyst: TestUser;
  let other: TestUser;
  let outsider: TestUser;
  let org: string;
  let metric: MetricDetail;
  const llm = new ScriptedLlm();

  beforeAll(async () => {
    admin = await connectAdmin();
    app = await createTestApp({ llm });
    worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(llm)
      .compile();
    worker.useLogger(false);
    await worker.init();

    owner = await registerUser(app, { label: 'iv-owner', organizationName: 'Investigation Org' });
    org = owner.organizationId!;
    const invite = async (role: string) =>
      (await client(app).post('/api/v1/invitations', owner, org).send({ role }).expect(201)).body
        .token as string;
    analyst = await registerUser(app, { label: 'iv-an', invitationToken: await invite('analyst') });
    other = await registerUser(app, {
      label: 'iv-other',
      invitationToken: await invite('analyst'),
    });
    outsider = await registerUser(app, { label: 'iv-out', organizationName: 'Elsewhere' });

    const datasets: Record<string, string> = {};
    for (const [name, lines] of [
      ['orders', ORDERS],
      ['customers', CUSTOMERS],
    ] as const) {
      const dataset = await client(app)
        .post('/api/v1/datasets', owner, org)
        .send({ name })
        .expect(201);
      const upload = await client(app)
        .post(`/api/v1/datasets/${dataset.body.id}/imports`, owner, org)
        .attach('file', Buffer.from(`${lines.join('\n')}\n`), `${name}.csv`)
        .field('options', JSON.stringify({ locale: 'en' }))
        .expect(202);
      for (let i = 0; i < 150; i++) {
        const job = (await client(app).get(`/api/v1/imports/${upload.body.id}`, owner, org))
          .body as ImportJob;
        if (job.status === 'SUCCEEDED') break;
        if (job.status === 'FAILED') throw new Error(JSON.stringify(job.error));
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      datasets[name] = dataset.body.id as string;
    }
    const post = async <T>(path: string, body: object): Promise<T> => {
      const res = await client(app).post(`/api/v1${path}`, owner, org).send(body);
      if (res.status >= 300) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body as T;
    };
    let model = await post<SemanticModelDetail>('/semantic-models', {
      key: 'sales',
      name: 'Sales',
    });
    for (const [key, dataset, pk] of [
      ['order', 'orders', 'order_id'],
      ['customer', 'customers', 'customer_id'],
    ] as const) {
      model = await post(`/semantic-models/${model.id}/entities`, {
        key,
        name: key,
        datasetId: datasets[dataset],
        primaryKey: [pk],
      });
    }
    const entity = (key: string) => model.entities.find((e) => e.key === key)!.id;
    for (const [key, type, expr] of [
      ['order_date', 'TIME', 'created_at'],
      ['status', 'CATEGORICAL', 'status'],
    ]) {
      await post(`/semantic-entities/${entity('order')}/dimensions`, {
        key,
        name: key,
        type,
        expr,
      });
    }
    await post(`/semantic-entities/${entity('customer')}/dimensions`, {
      key: 'region',
      name: 'Region',
      type: 'CATEGORICAL',
      expr: 'region',
    });
    await post(`/semantic-entities/${entity('order')}/measures`, {
      key: 'revenue',
      name: 'Revenue',
      agg: 'sum',
      expr: 'amount',
    });
    await post(`/semantic-models/${model.id}/relationships`, {
      fromEntityId: entity('order'),
      toEntityId: entity('customer'),
      joinColumns: [{ from: 'customer_id', to: 'customer_id' }],
      cardinality: 'MANY_TO_ONE',
    });
    await post(`/semantic-models/${model.id}/publish`, {});
    metric = await post<MetricDetail>(`/semantic-models/${model.id}/metrics`, {
      key: 'paid_revenue',
      label: 'Doanh thu',
      definition: {
        type: 'SIMPLE',
        measure: 'order.revenue',
        filters: [{ member: 'order.status', op: 'eq', values: ['PAID'] }],
        timeDimension: 'order.order_date',
      },
    });
    await post(`/metric-versions/${metric.draft!.id}/publish`, {});
  }, 120_000);

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    if (admin) {
      await cleanupTestData(admin);
      await admin.end();
    }
  });

  beforeEach(() => {
    llm.requests = [];
  });

  let n = 0;
  let firstRun: InvestigationDetail;
  let firstEvidence: Evidence[];
  /** Unique goal per test; the scripted planner replies by goal. */
  const start = async (
    replies: Reply[],
    options: { user?: TestUser; requireApproval?: boolean } = {},
  ) => {
    const goal = `Investigation number ${'abcdefghijklmnop'[n++]} about revenue`;
    llm.scripts.set(goal, replies);
    const res = await client(app)
      .post('/api/v1/investigations', options.user ?? analyst, org)
      .send({ model: 'sales', goal, requireApproval: options.requireApproval ?? false })
      .expect(202);
    return res.body as InvestigationDetail;
  };
  const get = async (id: string, user = analyst) =>
    (await client(app).get(`/api/v1/investigations/${id}`, user, org).expect(200))
      .body as InvestigationDetail;
  const waitFor = async (id: string, statuses: InvestigationStatus[], user = analyst) => {
    for (let i = 0; i < 150; i++) {
      const inv = await get(id, user);
      if (statuses.includes(inv.status)) return inv;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Investigation ${id} did not reach ${statuses.join('|')}`);
  };
  const events = async (id: string, lastEventId?: string) => {
    const req = client(app).get(`/api/v1/investigations/${id}/events`, analyst, org);
    if (lastEventId) req.set('last-event-id', lastEventId);
    const res = await req
      .buffer(true)
      .parse((response, done) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => done(null, text));
      })
      .expect(200);
    return (res.body as string)
      .split('\n\n')
      .filter((block) => block.startsWith('id: '))
      .map((block) => {
        const [idLine, dataLine] = block.split('\n');
        return { id: idLine!.slice(4), event: JSON.parse(dataLine!.slice(6)) as { type: string } };
      });
  };

  it('plans and runs every step as the author, then streams the history', async () => {
    const created = await start([call('propose_plan', PLAN)]);
    expect(created.status).toBe('QUEUED');
    const done = await waitFor(created.id, ['COMPLETED', 'PARTIAL', 'FAILED']);
    expect(done.status).toBe('COMPLETED');
    expect(done.steps.map((s) => [s.stepKey, s.status])).toEqual([
      ['s1', 'SUCCEEDED'],
      ['s2', 'SUCCEEDED'],
      ['s3', 'SUCCEEDED'],
      ['s4', 'SUCCEEDED'],
    ]);
    expect(done.pinned).toEqual({ modelRevision: 1, metrics: { paid_revenue: 1 } });
    expect(done.usage).toMatchObject({ steps: 4, queries: 8, tokens: 1200 }); // 2 + 4 + 1 + 1

    // The scoped step was limited to the top contributor found by s2, on the server.
    const s3 = await admin.query<{ input: { filters: unknown[] } }>(
      `SELECT input FROM app.investigation_steps WHERE investigation_id = $1 AND step_key = 's3'`,
      [created.id],
    );
    expect(s3.rows[0]!.input.filters).toEqual([
      { member: 'customer.region', op: 'in', values: ['North'] },
    ]);
    const s4 = done.steps[3]!.output as {
      reports: { member: string; anomalies: { period: string }[] }[];
    };
    expect(s4.reports.find((r) => r.member === 'North')!.anomalies[0]!.period).toMatch(
      /^2026-10-20/,
    );
    const history = await admin.query<{ source: string; user_id: string }>(
      `SELECT DISTINCT source, user_id FROM app.query_history WHERE id = ANY($1)`,
      [done.steps.flatMap((s) => s.queryHistoryIds)],
    );
    expect(history.rows).toEqual([{ source: 'INVESTIGATION', user_id: analyst.userId }]);

    // The planner saw the goal and the catalog – never data values.
    const sent = JSON.stringify(llm.requests);
    expect(sent).toContain('paid_revenue');
    expect(sent).not.toContain('North');

    const all = await events(created.id);
    expect(all.map((e) => e.event.type)).toEqual([
      'status',
      'status',
      'plan_ready',
      'status',
      ...Array.from({ length: 4 }, () => ['step_started', 'budget', 'step_completed']).flat(),
      'status', // VALIDATING
      'hypothesis',
      'findings',
      'status',
      'done',
    ]);
    const resumed = await events(created.id, all[all.length - 3]!.id);
    expect(resumed.map((e) => e.event.type)).toEqual(['status', 'done']);

    // Hypotheses checked by the deterministic rules; findings tied to evidence.
    expect(done.hypotheses).toEqual([
      expect.objectContaining({
        key: 'h1',
        status: 'SUPPORTED',
        rule: expect.objectContaining({
          reason: 'MEMBER_SHARE_ABOVE',
          observed: expect.objectContaining({ member: 'North' }),
        }),
      }),
    ]);
    expect(done.findings.length).toBeGreaterThanOrEqual(4);
    const importance = done.findings.map((f) => f.importance);
    expect(importance).toEqual([...importance].sort((a, b) => b - a));
    expect(done.findings.every((f) => f.verified && f.evidenceIds.length === 1)).toBe(true);
    expect(done.findings.map((f) => f.kind)).toEqual(
      expect.arrayContaining(['metric_change', 'driver', 'trend', 'anomaly']),
    );

    const evidence = (
      await client(app)
        .get(`/api/v1/investigations/${created.id}/evidence`, analyst, org)
        .expect(200)
    ).body as Evidence[];
    expect(evidence.map((e) => [e.stepKey, e.kind])).toEqual([
      ['s1', 'compare_periods'],
      ['s2', 'contribution'],
      ['s3', 'trend'],
      ['s4', 'anomaly'],
    ]);
    expect(evidence[1]).toMatchObject({
      versions: {
        modelRevision: 1,
        metrics: [{ key: 'paid_revenue', version: 1 }],
        datasets: expect.arrayContaining([
          expect.objectContaining({ name: 'orders', versionNo: 1 }),
        ]),
      },
      values: expect.objectContaining({ 'top.0.member': 'North' }),
    });
    expect(evidence[1]!.queries).toHaveLength(4);
    expect(evidence[1]!.results).toHaveLength(4);
    const ids = new Set(evidence.map((e) => e.id));
    expect(done.findings.every((f) => ids.has(f.evidenceIds[0]!))).toBe(true);
    firstRun = done;
    firstEvidence = evidence;
  });

  it('gives invalid plans back to the planner, which corrects them', async () => {
    const bad = { ...PLAN, steps: [{ ...PLAN.steps[0], metrics: ['profit'] }] };
    const created = await start([
      call('propose_plan', bad),
      call('propose_plan', { ...PLAN, steps: [PLAN.steps[0]], hypotheses: [] }),
    ]);
    const done = await waitFor(created.id, ['COMPLETED', 'PARTIAL', 'FAILED']);
    expect(done.status).toBe('COMPLETED');
    const correction = llm.requests[1]!.messages.at(-1)!;
    expect(correction.role).toBe('tool');
    expect(correction.content).toContain('UNKNOWN_METRIC');
  });

  it('fails after three invalid plans, or when the goal cannot be planned', async () => {
    const sql = { ...PLAN, steps: [{ ...PLAN.steps[0], sql: 'DROP TABLE app.users' }] };
    const invalid = await start([
      call('propose_plan', sql),
      call('propose_plan', sql),
      call('propose_plan', sql),
    ]);
    expect(await waitFor(invalid.id, ['FAILED'])).toMatchObject({
      errorCode: 'PLAN_INVALID',
      errorMessage: 'PLAN_INVALID',
    });

    const impossible = await start([
      call('cannot_plan', { reason: 'Không có dữ liệu lợi nhuận.' }),
    ]);
    expect(await waitFor(impossible.id, ['FAILED'])).toMatchObject({
      errorCode: 'PLAN_NOT_POSSIBLE',
      errorMessage: 'Không có dữ liệu lợi nhuận.',
    });
  });

  it('waits for approval when asked, and runs once approved', async () => {
    const created = await start(
      [call('propose_plan', { ...PLAN, steps: [PLAN.steps[0]], hypotheses: [] })],
      {
        requireApproval: true,
      },
    );
    const waiting = await waitFor(created.id, ['AWAITING_APPROVAL']);
    expect(waiting.plan?.steps).toHaveLength(1);
    expect(waiting.steps[0]!.status).toBe('PENDING');
    await client(app).post(`/api/v1/investigations/${created.id}/approve`, other, org).expect(404);
    await client(app)
      .post(`/api/v1/investigations/${created.id}/approve`, analyst, org)
      .expect(200);
    expect((await waitFor(created.id, ['COMPLETED'])).status).toBe('COMPLETED');
    await client(app)
      .post(`/api/v1/investigations/${created.id}/approve`, analyst, org)
      .expect(409);
  });

  it('cancels, then deletes', async () => {
    const created = await start([call('propose_plan', PLAN)], { requireApproval: true });
    await waitFor(created.id, ['AWAITING_APPROVAL']);
    await client(app).delete(`/api/v1/investigations/${created.id}`, analyst, org).expect(409);
    const cancelled = (
      await client(app)
        .post(`/api/v1/investigations/${created.id}/cancel`, analyst, org)
        .expect(200)
    ).body as InvestigationDetail;
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.steps.every((s) => s.status === 'SKIPPED')).toBe(true);
    await client(app).post(`/api/v1/investigations/${created.id}/cancel`, analyst, org).expect(409);
    await client(app).delete(`/api/v1/investigations/${created.id}`, analyst, org).expect(204);
    await client(app).get(`/api/v1/investigations/${created.id}`, analyst, org).expect(404);
  });

  it('resumes after a worker crash without repeating finished steps', async () => {
    const created = await start([call('propose_plan', PLAN)], { requireApproval: true });
    await waitFor(created.id, ['AWAITING_APPROVAL']);
    // Approve without a job: the test drives the orchestrator like two worker attempts.
    await admin.query(`UPDATE app.investigations SET status = 'RUNNING' WHERE id = $1`, [
      created.id,
    ]);
    const orchestrator = worker.get(InvestigationOrchestrator);
    const tools = worker.get(AnalysisToolsService);
    const original = tools.run.bind(tools);
    const spy = vi.spyOn(tools, 'run').mockImplementation(async (ctx, input) => {
      if (
        input.tool === 'contribution' &&
        spy.mock.calls.filter((c) => c[1].tool === 'contribution').length === 1
      ) {
        throw new Error('worker died');
      }
      return original(ctx, input);
    });
    const job = { organizationId: org, userId: analyst.userId, investigationId: created.id };
    try {
      await expect(orchestrator.run(job, false)).rejects.toThrow('worker died');
      const mid = await get(created.id);
      expect(mid.steps.map((s) => [s.stepKey, s.status, s.attempt])).toEqual([
        ['s1', 'SUCCEEDED', 1],
        ['s2', 'RUNNING', 1],
        ['s3', 'PENDING', 0],
        ['s4', 'PENDING', 0],
      ]);
      expect(await orchestrator.run(job, false)).toBe('COMPLETED');
      expect(spy.mock.calls.filter((c) => c[1].tool === 'compare_periods')).toHaveLength(1);
      const resumedRun = await get(created.id);
      expect(resumedRun.steps[1]).toMatchObject({ status: 'SUCCEEDED', attempt: 2 });
      // One evidence per finished step: the crashed attempt left none behind.
      const count = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.evidence WHERE investigation_id = $1`,
        [created.id],
      );
      expect(count.rows[0]!.n).toBe(4);
      expect(resumedRun.hypotheses[0]!.status).toBe('SUPPORTED');
    } finally {
      spy.mockRestore();
    }
    // A job whose ids do not belong together sees nothing.
    expect(await orchestrator.run({ ...job, userId: other.userId }, true)).toBe('skipped');
    expect(await orchestrator.run({ ...job, organizationId: outsider.organizationId! }, true)).toBe(
      'skipped',
    );
  });

  it('stops at the time budget with a partial result', async () => {
    const created = await start([call('propose_plan', PLAN)], { requireApproval: true });
    await waitFor(created.id, ['AWAITING_APPROVAL']);
    await admin.query(
      `UPDATE app.investigations SET budget = jsonb_set(budget, '{maxDurationMs}', '0') WHERE id = $1`,
      [created.id],
    );
    await client(app)
      .post(`/api/v1/investigations/${created.id}/approve`, analyst, org)
      .expect(200);
    const done = await waitFor(created.id, ['PARTIAL', 'COMPLETED', 'FAILED']);
    expect(done).toMatchObject({ status: 'PARTIAL', errorCode: 'BUDGET_EXCEEDED' });
    expect(
      done.steps.every((s) => s.status === 'SKIPPED' && s.errorCode === 'BUDGET_EXCEEDED'),
    ).toBe(true);
    // Validation still runs on what ran: nothing, so the hypothesis stays untested.
    expect(done.hypotheses).toEqual([
      expect.objectContaining({ key: 'h1', status: 'UNTESTED', evidenceIds: [] }),
    ]);
    expect(done.findings).toEqual([]);
  });

  it('never mixes definitions: a newly published metric version stops the run', async () => {
    const created = await start([call('propose_plan', PLAN)], { requireApproval: true });
    await waitFor(created.id, ['AWAITING_APPROVAL']);
    const draft = (
      await client(app)
        .post(`/api/v1/metrics/${metric.id}/versions`, owner, org)
        .send({
          label: 'Doanh thu',
          definition: {
            type: 'SIMPLE',
            measure: 'order.revenue',
            timeDimension: 'order.order_date',
          },
        })
        .expect(201)
    ).body as MetricDetail;
    await client(app)
      .post(`/api/v1/metric-versions/${draft.draft!.id}/publish`, owner, org)
      .expect(200);
    await client(app)
      .post(`/api/v1/investigations/${created.id}/approve`, analyst, org)
      .expect(200);
    expect(await waitFor(created.id, ['FAILED', 'COMPLETED', 'PARTIAL'])).toMatchObject({
      status: 'FAILED',
      errorCode: 'MODEL_CHANGED',
    });

    // Earlier investigations keep their evidence as it was: no remapping to version 2.
    const again = (
      await client(app)
        .get(`/api/v1/investigations/${firstRun.id}/evidence`, analyst, org)
        .expect(200)
    ).body as Evidence[];
    expect(again).toEqual(firstEvidence);
    expect((await get(firstRun.id)).findings).toEqual(firstRun.findings);
  });

  it('keeps evidence private and append-only in the database', async () => {
    loadAppConfig();
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const count = async (userId: string) => {
        await db.query('BEGIN');
        await db.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
        await db.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
        const rows = await Promise.all(
          ['evidence', 'hypotheses', 'findings'].map((t) =>
            db.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM app.${t} WHERE investigation_id = $1`,
              [firstRun.id],
            ),
          ),
        );
        await db.query('ROLLBACK');
        return rows.map((r) => r.rows[0]!.n);
      };
      expect(await count(analyst.userId)).toEqual([4, 1, firstRun.findings.length]);
      expect(await count(owner.userId)).toEqual([0, 0, 0]);
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
      await db.query(`SELECT set_config('app.user_id', $1, true)`, [analyst.userId]);
      await expect(
        db.query(`UPDATE app.evidence SET values = '{}' WHERE investigation_id = $1`, [
          firstRun.id,
        ]),
      ).rejects.toThrow(/permission denied/);
      await db.query('ROLLBACK');
    } finally {
      await db.end();
    }
  });

  it('stops when the author loses access', async () => {
    const created = await start([call('propose_plan', PLAN)], {
      user: other,
      requireApproval: true,
    });
    await waitFor(created.id, ['AWAITING_APPROVAL'], other);
    await admin.query(`UPDATE app.investigations SET status = 'RUNNING' WHERE id = $1`, [
      created.id,
    ]);
    const membership = await admin.query<{ id: string }>(
      `SELECT id FROM app.memberships WHERE user_id = $1 AND organization_id = $2`,
      [other.userId, org],
    );
    await client(app).delete(`/api/v1/members/${membership.rows[0]!.id}`, owner, org).expect(204);
    const status = await worker
      .get(InvestigationOrchestrator)
      .run({ organizationId: org, userId: other.userId, investigationId: created.id }, true);
    expect(status).toBe('FAILED');
    const row = await admin.query(`SELECT error_code FROM app.investigations WHERE id = $1`, [
      created.id,
    ]);
    expect(row.rows[0]).toEqual({ error_code: 'FORBIDDEN' });
  });

  it('keeps investigations private to their author and organization', async () => {
    const created = await start([
      call('propose_plan', { ...PLAN, steps: [PLAN.steps[0]], hypotheses: [] }),
    ]);
    await waitFor(created.id, ['COMPLETED']);
    const path = `/api/v1/investigations/${created.id}`;
    await client(app).get(path, owner, org).expect(404); // even the organization owner
    await client(app).get(`${path}/events`, owner, org).expect(404);
    await client(app).post(`${path}/cancel`, owner, org).expect(404);
    await client(app).delete(path, owner, org).expect(404);
    const outsiderOrg = outsider.organizationId!;
    await client(app).get(path, outsider, outsiderOrg).expect(404);
    await client(app).get(path, outsider, org).expect(403);
    const mine = (await client(app).get('/api/v1/investigations', owner, org).expect(200))
      .body as unknown[];
    expect(mine).toEqual([]);
  });

  it('limits concurrent investigations per user', async () => {
    const quota = await registerUser(app, {
      label: 'iv-quota',
      invitationToken: (
        await client(app)
          .post('/api/v1/invitations', owner, org)
          .send({ role: 'analyst' })
          .expect(201)
      ).body.token as string,
    });
    for (let i = 0; i < 2; i++)
      await start([call('propose_plan', PLAN)], { user: quota, requireApproval: true });
    const res = await client(app)
      .post('/api/v1/investigations', quota, org)
      .send({ model: 'sales', goal: 'One more investigation please' })
      .expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    await client(app)
      .post('/api/v1/investigations', quota, org)
      .send({ model: 'nope', goal: 'x' })
      .expect(400);
  });
});
