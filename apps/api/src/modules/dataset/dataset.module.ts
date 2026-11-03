import { tmpdir } from 'node:os';
import { extname } from 'node:path';
import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { IMPORT_LIMITS } from '@insightai/contracts';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.module';
import { ValidationError } from '../../platform/errors/app-error';
import { AuditModule } from '../audit/audit.module';
import { importLimits } from '../import/import-limits';
import { DatasetController, ImportController } from './dataset.controller';
import { DatasetService } from './dataset.service';
import { ImportService } from './import.service';

@Module({
  imports: [
    AuditModule,
    // Uploads go to a temp file (never fully into memory) and are deleted after being stored.
    MulterModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        dest: config.WORK_DIR ?? tmpdir(),
        limits: {
          fileSize: importLimits(config).maxFileBytes,
          files: 1,
          fields: 5,
          fieldSize: 16 * 1024,
        },
        // Synchronous filter: a cheap first check; content is verified after upload.
        fileFilter: (_req, file, callback) => {
          const accepted = (IMPORT_LIMITS.acceptedExtensions as readonly string[]).includes(
            extname(file.originalname).toLowerCase(),
          );
          callback(
            accepted ? null : new ValidationError('Only .csv and .xlsx files are accepted'),
            accepted,
          );
        },
      }),
    }),
  ],
  controllers: [DatasetController, ImportController],
  providers: [DatasetService, ImportService],
  exports: [DatasetService],
})
export class DatasetModule {}
