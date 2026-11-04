import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.module';
import { QueryEngineModule } from '../query-engine/query-engine.module';
import { SemanticModule } from '../semantic/semantic.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { LLM_PROVIDER } from './llm-provider';
import { OpenAiProvider } from './openai-provider';

@Module({
  imports: [QueryEngineModule, SemanticModule],
  controllers: [AiController],
  providers: [
    AiService,
    {
      provide: LLM_PROVIDER,
      inject: [APP_CONFIG],
      // No key → no provider: the AI endpoints answer AI_UNAVAILABLE.
      useFactory: (config: AppConfig) =>
        config.OPENAI_API_KEY && config.OPENAI_MODEL
          ? new OpenAiProvider(config.OPENAI_API_KEY, config.OPENAI_MODEL, config.OPENAI_BASE_URL)
          : null,
    },
  ],
})
export class AiModule {}
