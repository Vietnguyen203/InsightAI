import { Module } from '@nestjs/common';
import { QualityRunnerService } from './quality-runner.service';
import { QualityProcessor } from './quality.processor';

/** Loaded only by the worker process. */
@Module({
  providers: [QualityRunnerService, QualityProcessor],
  exports: [QualityRunnerService],
})
export class QualityWorkerModule {}
