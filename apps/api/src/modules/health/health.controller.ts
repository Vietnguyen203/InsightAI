import { createHash, timingSafeEqual } from 'node:crypto';
import { Controller, Get, Headers, Inject, Res, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.module';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors/app-error';
import { opsKeys } from '../../platform/ops/ops-metrics.service';
import { REDIS_CLIENT } from '../../platform/queue/queue.module';
import { Public } from '../../platform/http/decorators';
import { DependencyHealthIndicator } from './dependency-health.indicator';

@ApiTags('health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly dependencies: DependencyHealthIndicator,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Liveness: the process is up. Never touches dependencies, so an outage elsewhere does not trigger restarts. */
  @Get('live')
  @ApiOkResponse({ description: 'Process is alive' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: PostgreSQL, Redis and object storage are reachable. When one is down the response
   * is 503 with the same per-component body (not a problem document), so callers can see which.
   */
  @Get('ready')
  @HealthCheck()
  @ApiOkResponse({ description: 'All dependencies are reachable' })
  @ApiServiceUnavailableResponse({ description: 'At least one dependency is down' })
  async ready(@Res({ passthrough: true }) res: Response): Promise<HealthCheckResult> {
    try {
      return await this.health.check([
        () => this.dependencies.database(),
        () => this.dependencies.redisCheck(),
        () => this.dependencies.objectStorage(),
      ]);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        res.status(503);
        return error.getResponse() as HealthCheckResult;
      }
      throw error;
    }
  }

  /**
   * Operations snapshot of the worker's monitor (D-58): API readiness, 5xx in the last 5 minutes,
   * queue backlog, disk usage, LLM tokens/cost today and the firing alerts. Totals only. Needs
   * `Authorization: Bearer <OPS_STATUS_TOKEN>`; without a configured token the endpoint does not
   * exist.
   * 503 when no fresh snapshot exists (monitor not running).
   */
  @Get('ops')
  @ApiOkResponse({ description: 'Latest operations snapshot' })
  async ops(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const token = this.config.OPS_STATUS_TOKEN;
    if (!token) throw new NotFoundError('Not found');
    const given = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(given), digest(token))) {
      throw new UnauthenticatedError('Invalid operations token');
    }
    res.setHeader('Cache-Control', 'no-store');
    const raw = await this.redis.get(opsKeys(this.config.QUEUE_PREFIX).snapshot);
    if (!raw) {
      res.status(503);
      return { status: 'unknown', detail: 'No recent snapshot: is the worker monitor running?' };
    }
    return JSON.parse(raw) as unknown;
  }
}
