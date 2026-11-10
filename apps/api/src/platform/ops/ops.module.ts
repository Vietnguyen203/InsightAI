import { Global, Module } from '@nestjs/common';
import { OpsMetricsService } from './ops-metrics.service';

@Global()
@Module({
  providers: [OpsMetricsService],
  exports: [OpsMetricsService],
})
export class OpsModule {}
