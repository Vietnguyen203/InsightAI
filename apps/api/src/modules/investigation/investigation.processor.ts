import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type InvestigationJobData, QueueName } from '../../platform/queue/queues';
import { InvestigationOrchestrator } from './orchestrator.service';

/** Planning waits on the LLM and steps on the data plane: a few at a time per worker. */
@Processor(QueueName.INVESTIGATION, { concurrency: 2 })
export class InvestigationProcessor extends WorkerHost {
  constructor(private readonly orchestrator: InvestigationOrchestrator) {
    super();
  }

  process(job: Job<InvestigationJobData>) {
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    return this.orchestrator.run(job.data, isFinalAttempt);
  }
}
