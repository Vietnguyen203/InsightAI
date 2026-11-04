import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuditModule } from './modules/audit/audit.module';
import { AccessTokenGuard } from './modules/auth/access-token.guard';
import { AuthModule } from './modules/auth/auth.module';
import { CleaningModule } from './modules/cleaning/cleaning.module';
import { DatasetModule } from './modules/dataset/dataset.module';
import { HealthModule } from './modules/health/health.module';
import { IamModule } from './modules/iam/iam.module';
import { TenantGuard } from './modules/iam/tenant.guard';
import { OrganizationModule } from './modules/organization/organization.module';
import { QualityModule } from './modules/quality/quality.module';
import { QueryEngineModule } from './modules/query-engine/query-engine.module';
import { SemanticModule } from './modules/semantic/semantic.module';
import { ProblemDetailsFilter } from './platform/errors/problem-details.filter';
import { PlatformModule } from './platform/platform.module';
import { RateLimitModule } from './platform/rate-limit/rate-limit.module';

@Module({
  imports: [
    PlatformModule,
    RateLimitModule,
    HealthModule,
    AuditModule,
    AuthModule,
    OrganizationModule,
    IamModule,
    DatasetModule,
    QualityModule,
    CleaningModule,
    SemanticModule,
    QueryEngineModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    // Global guards run in this order: rate limit → access token → tenant membership/permissions.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useExisting: AccessTokenGuard },
    { provide: APP_GUARD, useExisting: TenantGuard },
  ],
})
export class AppModule {}
