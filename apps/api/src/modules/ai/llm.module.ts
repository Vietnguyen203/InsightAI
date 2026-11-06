import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.module';
import { LLM_PROVIDER } from './llm-provider';
import { OpenAiProvider } from './openai-provider';

/** The configured LLM provider (or null), shared by Q&A and investigations. */
@Module({
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [APP_CONFIG],
      // No key → no provider: AI features answer AI_UNAVAILABLE.
      useFactory: (config: AppConfig) =>
        config.OPENAI_API_KEY && config.OPENAI_MODEL
          ? new OpenAiProvider(config.OPENAI_API_KEY, config.OPENAI_MODEL, config.OPENAI_BASE_URL)
          : null,
    },
  ],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
