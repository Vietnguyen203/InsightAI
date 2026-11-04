import { Module } from '@nestjs/common';
import { QueryEngineService } from './query-engine.service';
import { QueryController } from './query.controller';

/** Shared kernel: Semantic Query IR → validated SQL → result (used by KPI/AI modules later). */
@Module({
  controllers: [QueryController],
  providers: [QueryEngineService],
  exports: [QueryEngineService],
})
export class QueryEngineModule {}
