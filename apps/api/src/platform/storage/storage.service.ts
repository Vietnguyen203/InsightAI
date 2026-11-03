import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.module';

/**
 * S3-compatible object storage (SeaweedFS locally, see docker/compose.yml). Raw uploaded files are immutable objects;
 * upload/download operations are added with the import module in Phase 2.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.bucket = config.S3_BUCKET;
    this.client = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async checkBucket(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
