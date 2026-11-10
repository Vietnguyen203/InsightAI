import { statfs } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../platform/config/config.module';
import {
  alertText,
  type AlertNotification,
  type AlertState,
  costUsd,
  evaluate,
  type OpsSnapshot,
  transition,
} from '../platform/ops/alert-rules';
import { postWebhook, ping } from '../platform/ops/notifier';
import { epochMinute, opsKeys, utcDay } from '../platform/ops/ops-metrics.service';
import { REDIS_CLIENT } from '../platform/queue/queue.module';
import { QueueName } from '../platform/queue/queues';

/**
 * Operations monitor (D-58), in the worker process: every interval it measures API readiness,
 * 5xx rate, queue backlog, disk usage and today's LLM cost, sends FIRING/RESOLVED alerts to the
 * webhook (and the log), stores the snapshot for GET /health/ops and pings the dead-man switch.
 * With several workers a Redis lock makes one of them run each check.
 */
@Injectable()
export class OpsMonitorService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OpsMonitorService.name);
  private readonly keys: ReturnType<typeof opsKeys>;
  private readonly queues: Queue[];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(QueueName.IMPORT) importQueue: Queue,
    @InjectQueue(QueueName.PROFILING) profilingQueue: Queue,
    @InjectQueue(QueueName.QUALITY) qualityQueue: Queue,
    @InjectQueue(QueueName.CLEANING) cleaningQueue: Queue,
    @InjectQueue(QueueName.INVESTIGATION) investigationQueue: Queue,
  ) {
    this.keys = opsKeys(config.QUEUE_PREFIX);
    this.queues = [importQueue, profilingQueue, qualityQueue, cleaningQueue, investigationQueue];
  }

  get enabled(): boolean {
    return this.config.OPS_MONITOR_ENABLED ?? this.config.NODE_ENV === 'production';
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    const interval = this.config.OPS_MONITOR_INTERVAL_SECONDS * 1000;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
    this.logger.log(`Operations monitor every ${this.config.OPS_MONITOR_INTERVAL_SECONDS} s`);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** One scheduled check; skipped when another worker holds this interval's lock. */
  async tick(): Promise<void> {
    try {
      const ttl = Math.max(1, this.config.OPS_MONITOR_INTERVAL_SECONDS - 1);
      const locked = await this.redis.set(this.keys.lock, hostname(), 'EX', ttl, 'NX');
      if (locked !== 'OK') return;
      await this.check();
    } catch (error) {
      this.logger.error({ err: error }, 'Operations check failed');
    }
  }

  /** Measures, evaluates and notifies. Returns what was measured and sent (tests). */
  async check(
    now = new Date(),
  ): Promise<{ snapshot: OpsSnapshot; notifications: AlertNotification[] }> {
    const snapshot = await this.measure(now);
    const firing = evaluate(snapshot, {
      serverErrors5m: this.config.OPS_ALERT_5XX_PER_5MIN,
      queueWaiting: this.config.OPS_ALERT_QUEUE_WAITING,
      queueAgeSeconds: this.config.OPS_ALERT_QUEUE_AGE_SECONDS,
      diskPercent: this.config.OPS_ALERT_DISK_PERCENT,
      llmDailyBudgetUsd: this.config.OPS_LLM_DAILY_BUDGET_USD ?? null,
    });
    const previous = await this.loadAlerts();
    const { next, notifications } = transition(
      previous,
      firing,
      now,
      this.config.OPS_ALERT_REPEAT_MINUTES,
    );
    await this.redis
      .multi()
      .set(this.keys.alerts, JSON.stringify(next))
      .set(
        this.keys.snapshot,
        JSON.stringify({ ...snapshot, alerts: firing }),
        'EX',
        this.config.OPS_MONITOR_INTERVAL_SECONDS * 3,
      )
      .exec();

    this.logger.log({ ops: snapshot, alerts: firing.map((a) => a.key) }, 'ops snapshot');
    for (const n of notifications) await this.notify(n);
    if (this.config.OPS_HEARTBEAT_URL && !(await ping(this.config.OPS_HEARTBEAT_URL))) {
      this.logger.warn('Heartbeat ping failed');
    }
    return { snapshot, notifications };
  }

  /** Sends one notification (also used by `node dist/ops-alert-test.js`). */
  async notify(n: AlertNotification): Promise<boolean> {
    const text = alertText(n, hostname());
    if (n.status === 'FIRING') this.logger.error({ alert: n }, text);
    else this.logger.warn({ alert: n }, text);
    if (!this.config.OPS_ALERT_WEBHOOK_URL) return false;
    const sent = await postWebhook(this.config.OPS_ALERT_WEBHOOK_URL, { text, alert: n });
    if (!sent) this.logger.error({ alert: n.key }, 'Alert webhook failed');
    return sent;
  }

  private async measure(now: Date): Promise<OpsSnapshot> {
    const [api, serverErrors5m, queues, disks, llm] = await Promise.all([
      this.apiReadiness(),
      this.serverErrors(now),
      Promise.all(this.queues.map((q) => this.queueStats(q, now))),
      this.diskUsage(),
      this.llmToday(now),
    ]);
    return { checkedAt: now.toISOString(), api, serverErrors5m, queues, disks, llm };
  }

  private async apiReadiness(): Promise<OpsSnapshot['api']> {
    if (!this.config.OPS_API_URL) return null;
    try {
      const res = await fetch(new URL('/health/ready', this.config.OPS_API_URL), {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return { ok: true, status: res.status, detail: null };
      const body = (await res.json().catch(() => null)) as { error?: object } | null;
      const down = body?.error ? Object.keys(body.error).join(', ') : null;
      return { ok: false, status: res.status, detail: down ? `down: ${down}` : null };
    } catch (error) {
      return { ok: false, status: null, detail: (error as Error).name };
    }
  }

  private async serverErrors(now: Date): Promise<number> {
    const minute = epochMinute(now.getTime());
    const keys = Array.from({ length: 5 }, (_, i) => this.keys.serverErrors(minute - i));
    const values = await this.redis.mget(...keys);
    return values.reduce((sum, value) => sum + Number(value ?? 0), 0);
  }

  private async queueStats(queue: Queue, now: Date): Promise<OpsSnapshot['queues'][number]> {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    const [oldest] = await queue.getJobs(['waiting'], 0, 0, true);
    return {
      name: queue.name,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      oldestWaitingSeconds: oldest
        ? Math.max(0, Math.round((now.getTime() - oldest.timestamp) / 1000))
        : null,
    };
  }

  private async diskUsage(): Promise<OpsSnapshot['disks']> {
    const paths = this.config.OPS_DISK_PATHS?.length
      ? this.config.OPS_DISK_PATHS
      : [this.config.WORK_DIR ?? tmpdir()];
    const disks: OpsSnapshot['disks'] = [];
    for (const path of paths) {
      try {
        const s = await statfs(path);
        const used = (s.blocks - s.bfree) * s.bsize;
        const usable = used + s.bavail * s.bsize; // like df: space reserved for root excluded
        disks.push({
          path,
          usedPercent: usable > 0 ? (used / usable) * 100 : 0,
          freeBytes: s.bavail * s.bsize,
        });
      } catch (error) {
        this.logger.warn(`Disk usage of ${path} unavailable: ${(error as Error).message}`);
      }
    }
    return disks;
  }

  private async llmToday(now: Date): Promise<OpsSnapshot['llm']> {
    const day = utcDay(now.getTime());
    const fields = await this.redis.hgetall(this.keys.llmDay(day));
    let promptTokens = 0;
    let completionTokens = 0;
    let calls = 0;
    for (const [field, value] of Object.entries(fields)) {
      const n = Number(value);
      if (field.endsWith('|prompt')) promptTokens += n;
      else if (field.endsWith('|completion')) completionTokens += n;
      else if (field.endsWith('|calls')) calls += n;
    }
    return {
      day,
      promptTokens,
      completionTokens,
      calls,
      costUsd: costUsd(promptTokens, completionTokens, {
        input: this.config.OPS_LLM_PRICE_INPUT_PER_MTOK,
        output: this.config.OPS_LLM_PRICE_OUTPUT_PER_MTOK,
      }),
    };
  }

  private async loadAlerts(): Promise<Record<string, AlertState>> {
    const raw = await this.redis.get(this.keys.alerts);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, AlertState>;
    } catch {
      return {};
    }
  }
}
