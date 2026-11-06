import { Module } from '@nestjs/common';
import { QueryEngineModule } from '../query-engine/query-engine.module';
import { SemanticModule } from '../semantic/semantic.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { LlmModule } from './llm.module';

@Module({
  imports: [QueryEngineModule, SemanticModule, LlmModule],
  controllers: [AiController],
  providers: [AiService],
})
export class AiModule {}
