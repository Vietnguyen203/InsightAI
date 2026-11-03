import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type ProfilingJobData, QueueName } from '../../platform/queue/queues';
import { type ProfileOutcome, ProfilerService } from './profiler.service';

@Processor(QueueName.PROFILING, { concurrency: 2 })
export class ProfilingProcessor extends WorkerHost {
  constructor(private readonly profiler: ProfilerService) {
    super();
  }

  process(job: Job<ProfilingJobData>): Promise<ProfileOutcome> {
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    return this.profiler.run(job.data.organizationId, job.data.versionId, isFinalAttempt);
  }
}
