import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Global, Module } from '@nestjs/common';
import { parseEnv, type Env } from './env.schema';

export const APP_CONFIG = Symbol('APP_CONFIG');
export type AppConfig = Env;

/** Loads the repo-root `.env` outside production; real environments inject variables directly. */
export function loadAppConfig(): AppConfig {
  if (process.env.NODE_ENV !== 'production') {
    for (const candidate of [
      resolve(process.cwd(), '.env'),
      resolve(process.cwd(), '../../.env'),
    ]) {
      if (existsSync(candidate)) {
        process.loadEnvFile(candidate);
        break;
      }
    }
  }
  return parseEnv(process.env);
}

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: loadAppConfig }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
