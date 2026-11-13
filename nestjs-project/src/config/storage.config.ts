import { registerAs } from '@nestjs/config';
import { envString } from './video.constants';

/** S3-compatible storage (phase-03-videos/TD-04, TD-16). */
export default registerAs('storage', () => ({
  endpoint: envString('S3_ENDPOINT'),
  publicEndpoint: envString('S3_PUBLIC_ENDPOINT'),
  region: envString('S3_REGION'),
  bucket: envString('S3_BUCKET'),
  testBucket: envString('S3_TEST_BUCKET'),
  forcePathStyle: envString('S3_FORCE_PATH_STYLE') === 'true',
  accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
  // Read-only delivery identity (API only; absent in the worker), TD-04 rev.
  deliveryAccessKeyId: process.env.S3_DELIVERY_ACCESS_KEY_ID ?? '',
  deliverySecretAccessKey: process.env.S3_DELIVERY_SECRET_ACCESS_KEY ?? '',
}));
