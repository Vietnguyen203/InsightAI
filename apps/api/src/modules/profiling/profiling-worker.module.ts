import { Module } from '@nestjs/common';
import { ProfilerService } from './profiler.service';
import { ProfilingProcessor } from './profiling.processor';

/** Loaded only by the worker process. */
@Module({
  providers: [ProfilerService, ProfilingProcessor],
  exports: [ProfilerService],
})
export class ProfilingWorkerModule {}
