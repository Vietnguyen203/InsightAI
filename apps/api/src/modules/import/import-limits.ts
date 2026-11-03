import { IMPORT_LIMITS } from '@insightai/contracts';
import type { AppConfig } from '../../platform/config/config.module';

export function importLimits(config: AppConfig) {
  return {
    maxFileBytes: config.IMPORT_MAX_FILE_BYTES ?? IMPORT_LIMITS.maxFileBytes,
    maxRows: config.IMPORT_MAX_ROWS ?? IMPORT_LIMITS.maxRows,
    maxColumns: config.IMPORT_MAX_COLUMNS ?? IMPORT_LIMITS.maxColumns,
  };
}
