import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type QualityJobData, QueueName } from '../../platform/queue/queues';
import { type CheckOutcome, QualityRunnerService } from './quality-runner.service';

@Processor(QueueName.QUALITY, { concurrency: 2 })
export class QualityProcessor extends WorkerHost {
  constructor(private readonly runner: QualityRunnerService) {
    super();
  }

  process(job: Job<QualityJobData>): Promise<CheckOutcome> {
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    return this.runner.run(job.data.organizationId, job.data.checkId, isFinalAttempt);
  }
}
