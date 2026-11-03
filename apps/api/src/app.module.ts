import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { HealthModule } from './modules/health/health.module';
import { ProblemDetailsFilter } from './platform/errors/problem-details.filter';
import { PlatformModule } from './platform/platform.module';

@Module({
  imports: [PlatformModule, HealthModule],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppModule {}
