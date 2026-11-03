import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { QualityCoreModule } from '../quality/quality-core.module';
import { CleaningRunnerService } from './cleaning-runner.service';
import { CleaningProcessor } from './cleaning.processor';

/** Loaded only by the worker process. */
@Module({
  imports: [AuditModule, QualityCoreModule],
  providers: [CleaningRunnerService, CleaningProcessor],
  exports: [CleaningRunnerService],
})
export class CleaningWorkerModule {}
