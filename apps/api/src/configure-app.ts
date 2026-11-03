import { type INestApplication, RequestMethod } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { APP_CONFIG, type AppConfig } from './platform/config/config.module';

export const API_PREFIX = 'api/v1';

/** HTTP setup shared by main.ts and integration tests, so tests exercise the real configuration. */
export function configureApp(app: INestApplication): void {
  const config = app.get<AppConfig>(APP_CONFIG);

  app.use(helmet());
  app.enableCors({ origin: config.CORS_ORIGINS, credentials: true });
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  app.enableShutdownHooks();

  if (config.NODE_ENV !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('InsightAI API')
        .setDescription('InsightAI REST API. Errors use RFC 7807 application/problem+json.')
        .setVersion('0.1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('docs', app, document);
  }
}
