import { Module } from '@nestjs/common';
import { PlatformModule } from './platform/platform.module';
import { SystemProcessor } from './worker/system.processor';

/** Background worker process: BullMQ consumers only, no HTTP server. */
@Module({
  imports: [PlatformModule],
  providers: [SystemProcessor],
})
export class WorkerModule {}
