// Creates the S3 bucket named by S3_BUCKET if it does not exist. Development/CI and the self-hosted
// storage of docker/oracle/setup.sh only: other production buckets are provisioned outside the app.
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

const {
  S3_ENDPOINT,
  S3_REGION = 'us-east-1',
  S3_BUCKET,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
} = process.env;
if (!S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
  console.error('S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required');
  process.exit(1);
}

const client = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
});

// The storage container can take a few seconds to accept requests after start.
for (let attempt = 1; ; attempt++) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    console.log(`bucket ${S3_BUCKET} already exists`);
    break;
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 404) {
      await client.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
      console.log(`created bucket ${S3_BUCKET}`);
      break;
    }
    if (attempt >= 30) {
      console.error(`storage not reachable: ${error?.name ?? error}`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
client.destroy();
