import { Module } from '@nestjs/common';
import { CleaningWorkerModule } from './modules/cleaning/cleaning-worker.module';
import { ImportWorkerModule } from './modules/import/import-worker.module';
import { ProfilingWorkerModule } from './modules/profiling/profiling-worker.module';
import { QualityWorkerModule } from './modules/quality/quality-worker.module';
import { PlatformModule } from './platform/platform.module';
import { SystemProcessor } from './worker/system.processor';

/** Background worker process: BullMQ consumers only, no HTTP server. */
@Module({
  imports: [
    PlatformModule,
    ImportWorkerModule,
    ProfilingWorkerModule,
    QualityWorkerModule,
    CleaningWorkerModule,
  ],
  providers: [SystemProcessor],
})
export class WorkerModule {}
