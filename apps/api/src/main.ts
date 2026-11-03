import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { APP_CONFIG, type AppConfig } from './platform/config/config.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);

  const { PORT } = app.get<AppConfig>(APP_CONFIG);
  await app.listen(PORT);
  app.get(Logger).log(`API listening on port ${PORT}`);
}

void bootstrap();
