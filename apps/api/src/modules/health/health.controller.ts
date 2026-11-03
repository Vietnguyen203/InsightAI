import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus';
import { DependencyHealthIndicator } from './dependency-health.indicator';

@ApiTags('health')
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

  /** Readiness: PostgreSQL, Redis and object storage are reachable. */
  @Get('ready')
  @HealthCheck()
  @ApiOkResponse({ description: 'All dependencies are reachable' })
  @ApiServiceUnavailableResponse({ description: 'At least one dependency is down' })
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.dependencies.database(),
      () => this.dependencies.redisCheck(),
      () => this.dependencies.objectStorage(),
    ]);
  }
}
