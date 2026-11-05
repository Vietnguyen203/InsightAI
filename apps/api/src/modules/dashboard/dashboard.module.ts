import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { QueryEngineModule } from '../query-engine/query-engine.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [AuditModule, QueryEngineModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
