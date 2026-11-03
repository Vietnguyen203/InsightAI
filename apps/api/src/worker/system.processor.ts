import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QueueName, SystemJob } from '../platform/queue/queues';

export interface PingResult {
  pong: true;
  processedAt: string;
}

/** Smoke-test processor proving the queue → worker path works end to end. */
@Processor(QueueName.SYSTEM)
export class SystemProcessor extends WorkerHost {
  private readonly logger = new Logger(SystemProcessor.name);

  process(job: Job): Promise<PingResult> {
    if (job.name !== SystemJob.PING) {
      return Promise.reject(new Error(`Unknown system job: ${job.name}`));
    }
    this.logger.log({ jobId: job.id }, 'ping received');
    return Promise.resolve({ pong: true, processedAt: new Date().toISOString() });
  }
}
