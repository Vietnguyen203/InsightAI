import { Module } from '@nestjs/common';
import { QueryEngineModule } from '../query-engine/query-engine.module';
import { SemanticModule } from '../semantic/semantic.module';
import { AnalysisToolsService } from './analysis-tools.service';

/** AI Data Analyst (Phase 6): analysis tools now; planner and orchestrator follow in 6C. */
@Module({
  imports: [QueryEngineModule, SemanticModule],
  providers: [AnalysisToolsService],
  exports: [AnalysisToolsService],
})
export class InvestigationModule {}
