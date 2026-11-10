/** What the operations monitor measured in one check (D-58). Totals only, no tenant data. */
export interface OpsSnapshot {
  checkedAt: string;
  /** Readiness of the API (null when OPS_API_URL is not set). */
  api: { ok: boolean; status: number | null; detail: string | null } | null;
  /** 5xx responses of all API instances in the last 5 minutes. */
  serverErrors5m: number;
  queues: {
    name: string;
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    oldestWaitingSeconds: number | null;
  }[];
  disks: { path: string; usedPercent: number; freeBytes: number }[];
  llm: {
    day: string;
    promptTokens: number;
    completionTokens: number;
    calls: number;
    /** USD, null when no token prices are configured. */
    costUsd: number | null;
  };
}

export interface AlertThresholds {
  serverErrors5m: number;
  queueWaiting: number;
  queueAgeSeconds: number;
  diskPercent: number;
  llmDailyBudgetUsd: number | null;
}

export interface AlertCondition {
  /** Stable id, e.g. `queue_backlog:import` or `disk:/data`. */
  key: string;
  summary: string;
}

/** The alert conditions that hold for a snapshot. */
export function evaluate(snapshot: OpsSnapshot, t: AlertThresholds): AlertCondition[] {
  const firing: AlertCondition[] = [];
  if (snapshot.api && !snapshot.api.ok) {
    firing.push({
      key: 'api_not_ready',
      summary: `API not ready (${snapshot.api.status ?? 'no response'}${snapshot.api.detail ? `: ${snapshot.api.detail}` : ''})`,
    });
  }
  if (snapshot.serverErrors5m >= t.serverErrors5m) {
    firing.push({
      key: 'server_errors',
      summary: `${snapshot.serverErrors5m} server errors (5xx) in the last 5 minutes (threshold ${t.serverErrors5m})`,
    });
  }
  for (const q of snapshot.queues) {
    const age = q.oldestWaitingSeconds ?? 0;
    if (q.waiting >= t.queueWaiting || age >= t.queueAgeSeconds) {
      firing.push({
        key: `queue_backlog:${q.name}`,
        summary: `Queue "${q.name}": ${q.waiting} waiting, oldest ${age} s (thresholds ${t.queueWaiting} jobs / ${t.queueAgeSeconds} s)`,
      });
    }
  }
  for (const d of snapshot.disks) {
    if (d.usedPercent >= t.diskPercent) {
      firing.push({
        key: `disk:${d.path}`,
        summary: `Disk ${d.path} ${d.usedPercent.toFixed(1)} % used (threshold ${t.diskPercent} %)`,
      });
    }
  }
  if (
    t.llmDailyBudgetUsd !== null &&
    snapshot.llm.costUsd !== null &&
    snapshot.llm.costUsd >= t.llmDailyBudgetUsd
  ) {
    firing.push({
      key: 'llm_cost',
      summary: `LLM cost today ${snapshot.llm.costUsd.toFixed(2)} USD (budget ${t.llmDailyBudgetUsd} USD)`,
    });
  }
  return firing;
}

/** Stored per alert key: when it started firing and when it was last sent. */
export interface AlertState {
  since: string;
  notifiedAt: string;
}

export interface AlertNotification {
  status: 'FIRING' | 'RESOLVED';
  key: string;
  summary: string;
  since: string;
}

/**
 * Compares the firing conditions with the stored state: new or still-firing alerts past the repeat
 * interval are sent as FIRING, alerts that stopped are sent once as RESOLVED.
 */
export function transition(
  previous: Record<string, AlertState>,
  firing: AlertCondition[],
  now: Date,
  repeatMinutes: number,
): { next: Record<string, AlertState>; notifications: AlertNotification[] } {
  const next: Record<string, AlertState> = {};
  const notifications: AlertNotification[] = [];
  const iso = now.toISOString();
  for (const condition of firing) {
    const before = previous[condition.key];
    if (!before) {
      next[condition.key] = { since: iso, notifiedAt: iso };
      notifications.push({ status: 'FIRING', ...condition, since: iso });
    } else if (now.getTime() - Date.parse(before.notifiedAt) >= repeatMinutes * 60_000) {
      next[condition.key] = { since: before.since, notifiedAt: iso };
      notifications.push({ status: 'FIRING', ...condition, since: before.since });
    } else {
      next[condition.key] = before;
    }
  }
  for (const [key, state] of Object.entries(previous)) {
    if (!next[key]) {
      notifications.push({
        status: 'RESOLVED',
        key,
        summary: `Resolved: ${key}`,
        since: state.since,
      });
    }
  }
  return { next, notifications };
}

export function costUsd(
  promptTokens: number,
  completionTokens: number,
  pricePerMTok: { input: number; output: number },
): number | null {
  if (pricePerMTok.input === 0 && pricePerMTok.output === 0) return null;
  return (promptTokens * pricePerMTok.input + completionTokens * pricePerMTok.output) / 1_000_000;
}

export function alertText(n: AlertNotification, site: string): string {
  const icon = n.status === 'FIRING' ? '🔴' : '✅';
  return `${icon} [InsightAI ${site}] ${n.status}: ${n.summary} (since ${n.since})`;
}
