import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type ImportJobData, QueueName } from '../../platform/queue/queues';
import { ImportRunnerService, type RunOutcome } from './import-runner.service';

/** Imports are CPU/IO heavy: a small concurrency per worker process keeps memory predictable. */
@Processor(QueueName.IMPORT, { concurrency: 2 })
export class ImportProcessor extends WorkerHost {
  constructor(private readonly runner: ImportRunnerService) {
    super();
  }

  process(job: Job<ImportJobData>): Promise<RunOutcome> {
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    return this.runner.run(job.data.organizationId, job.data.importJobId, isFinalAttempt);
  }
}
