import { describe, expect, it } from 'vitest';
import {
  type AlertThresholds,
  costUsd,
  evaluate,
  type OpsSnapshot,
  transition,
} from './alert-rules';

const thresholds: AlertThresholds = {
  serverErrors5m: 10,
  queueWaiting: 100,
  queueAgeSeconds: 600,
  diskPercent: 85,
  llmDailyBudgetUsd: 5,
};

const healthy = (): OpsSnapshot => ({
  checkedAt: '2026-11-10T08:00:00.000Z',
  api: { ok: true, status: 200, detail: null },
  serverErrors5m: 0,
  queues: [
    { name: 'import', waiting: 0, active: 1, delayed: 0, failed: 3, oldestWaitingSeconds: null },
  ],
  disks: [{ path: '/data', usedPercent: 40, freeBytes: 10 ** 10 }],
  llm: { day: '2026-11-10', promptTokens: 1000, completionTokens: 100, calls: 2, costUsd: 0.01 },
});

describe('evaluate', () => {
  it('fires nothing for a healthy system', () => {
    expect(evaluate(healthy(), thresholds)).toEqual([]);
  });

  it('fires each of the five indicators at its threshold', () => {
    const s = healthy();
    s.api = { ok: false, status: 503, detail: 'down: database' };
    s.serverErrors5m = 10;
    s.queues = [
      { name: 'import', waiting: 100, active: 0, delayed: 0, failed: 0, oldestWaitingSeconds: 5 },
      { name: 'quality', waiting: 1, active: 0, delayed: 0, failed: 0, oldestWaitingSeconds: 600 },
      {
        name: 'cleaning',
        waiting: 99,
        active: 0,
        delayed: 0,
        failed: 0,
        oldestWaitingSeconds: 599,
      },
    ];
    s.disks = [{ path: '/data', usedPercent: 85, freeBytes: 1 }];
    s.llm.costUsd = 5;
    const keys = evaluate(s, thresholds).map((a) => a.key);
    expect(keys).toEqual([
      'api_not_ready',
      'server_errors',
      'queue_backlog:import',
      'queue_backlog:quality',
      'disk:/data',
      'llm_cost',
    ]);
    expect(evaluate(s, thresholds)[0]!.summary).toContain('down: database');
  });

  it('skips checks that are not configured', () => {
    const s = healthy();
    s.api = null;
    s.llm.costUsd = null;
    expect(evaluate(s, { ...thresholds, llmDailyBudgetUsd: 0.001 })).toEqual([]);
    expect(
      evaluate(
        { ...healthy(), llm: { ...s.llm, costUsd: 99 } },
        { ...thresholds, llmDailyBudgetUsd: null },
      ),
    ).toEqual([]);
  });
});

describe('transition', () => {
  const t0 = new Date('2026-11-10T08:00:00Z');
  const later = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
  const disk = { key: 'disk:/data', summary: 'Disk /data 90 %' };

  it('sends FIRING once, repeats after the interval, then RESOLVED once', () => {
    const first = transition({}, [disk], t0, 240);
    expect(first.notifications).toEqual([
      { status: 'FIRING', key: 'disk:/data', summary: 'Disk /data 90 %', since: t0.toISOString() },
    ]);

    const quiet = transition(first.next, [disk], later(239), 240);
    expect(quiet.notifications).toEqual([]);
    expect(quiet.next).toEqual(first.next);

    const repeat = transition(quiet.next, [disk], later(240), 240);
    expect(repeat.notifications).toHaveLength(1);
    expect(repeat.notifications[0]).toMatchObject({ status: 'FIRING', since: t0.toISOString() });
    expect(repeat.next['disk:/data']!.notifiedAt).toBe(later(240).toISOString());

    const resolved = transition(repeat.next, [], later(250), 240);
    expect(resolved.notifications).toEqual([
      {
        status: 'RESOLVED',
        key: 'disk:/data',
        summary: 'Resolved: disk:/data',
        since: t0.toISOString(),
      },
    ]);
    expect(resolved.next).toEqual({});
    expect(transition(resolved.next, [], later(260), 240).notifications).toEqual([]);
  });
});

describe('costUsd', () => {
  it('prices tokens per million, or null without prices', () => {
    expect(costUsd(2_000_000, 500_000, { input: 0.5, output: 2 })).toBeCloseTo(2);
    expect(costUsd(2_000_000, 500_000, { input: 0, output: 0 })).toBeNull();
  });
});
