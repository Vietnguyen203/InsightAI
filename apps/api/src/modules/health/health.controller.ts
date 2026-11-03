import { Controller, Get, Res, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
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
}
