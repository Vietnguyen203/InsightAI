import { type INestApplication, RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { APP_CONFIG, type AppConfig } from './platform/config/config.module';

export const API_PREFIX = 'api/v1';

/** HTTP setup shared by main.ts and integration tests, so tests exercise the real configuration. */
export function configureApp(app: INestApplication): void {
  const config = app.get<AppConfig>(APP_CONFIG);

  // Client IPs (rate limiting, audit) are only correct behind a proxy if hops are declared.
  (app as NestExpressApplication).set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: config.CORS_ORIGINS, credentials: true });
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
      { path: 'health/ops', method: RequestMethod.GET },
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
