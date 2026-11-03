import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.module';

/**
 * S3-compatible object storage (SeaweedFS locally, see docker/compose.yml). Uploaded files are
 * immutable objects: written once, never overwritten.
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

  /**
   * Streams a local file to storage (multipart for large files) and returns its SHA-256,
   * computed on the same pass so the file is read only once.
   */
  async uploadFile(key: string, filePath: string): Promise<{ sha256: string }> {
    const hash = createHash('sha256');
    const body = new PassThrough();
    body.on('data', (chunk: Buffer) => hash.update(chunk));

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/octet-stream',
      },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
    });
    await Promise.all([pipeline(createReadStream(filePath), body), upload.done()]);
    return { sha256: hash.digest('hex') };
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) throw new Error(`Empty object body for ${key}`);
    await pipeline(response.Body as Readable, createWriteStream(filePath));
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
