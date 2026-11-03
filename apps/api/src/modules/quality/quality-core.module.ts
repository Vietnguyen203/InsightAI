import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { QualityCheckService } from './quality-check.service';
import { QualityRuleService } from './quality-rule.service';

/** Rule and check services shared by the API and the worker (no controllers, no processors). */
@Module({
  imports: [AuditModule],
  providers: [QualityRuleService, QualityCheckService],
  exports: [QualityRuleService, QualityCheckService],
})
export class QualityCoreModule {}
