import { Module } from '@nestjs/common';
import { LlmModule } from '../ai/llm.module';
import { IamModule } from '../iam/iam.module';
import { QueryEngineModule } from '../query-engine/query-engine.module';
import { SemanticModule } from '../semantic/semantic.module';
import { AnalysisToolsService } from './analysis-tools.service';
import { InvestigationEventsService } from './investigation-events.service';
import { InvestigationOrchestrator } from './orchestrator.service';
import { PlannerService } from './planner.service';

/** Shared by the API (create/read/stream) and the worker (plan/run). */
@Module({
  imports: [QueryEngineModule, SemanticModule, LlmModule, IamModule],
  providers: [
    AnalysisToolsService,
    PlannerService,
    InvestigationEventsService,
    InvestigationOrchestrator,
  ],
  exports: [
    AnalysisToolsService,
    PlannerService,
    InvestigationEventsService,
    InvestigationOrchestrator,
  ],
})
export class InvestigationCoreModule {}
