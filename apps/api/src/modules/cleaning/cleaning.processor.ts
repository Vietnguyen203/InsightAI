import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type CleaningJobData, QueueName } from '../../platform/queue/queues';
import { type CleaningOutcome, CleaningRunnerService } from './cleaning-runner.service';

@Processor(QueueName.CLEANING, { concurrency: 1 })
export class CleaningProcessor extends WorkerHost {
  constructor(private readonly runner: CleaningRunnerService) {
    super();
  }

  process(job: Job<CleaningJobData>): Promise<CleaningOutcome> {
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    return this.runner.run(job.data.organizationId, job.data.cleaningJobId, isFinalAttempt);
  }
}
