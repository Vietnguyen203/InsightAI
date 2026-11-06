import { Module } from '@nestjs/common';
import { InvestigationCoreModule } from './investigation-core.module';
import { InvestigationProcessor } from './investigation.processor';

/** Loaded only by the worker process. */
@Module({
  imports: [InvestigationCoreModule],
  providers: [InvestigationProcessor],
})
export class InvestigationWorkerModule {}
