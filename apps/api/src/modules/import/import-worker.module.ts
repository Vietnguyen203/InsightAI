import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ImportRunnerService } from './import-runner.service';
import { ImportProcessor } from './import.processor';

/** Loaded only by the worker process. */
@Module({
  imports: [AuditModule],
  providers: [ImportRunnerService, ImportProcessor],
  exports: [ImportRunnerService],
})
export class ImportWorkerModule {}
