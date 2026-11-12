import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { Provider } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  S3_CLIENTS,
  STORAGE_RETRY,
  STORAGE_TIMEOUTS,
} from './storage.constants';

/**
 * The three S3 clients of phase-03-videos/TD-04:
 * - `internal`: storage operations from API/worker (`S3_ENDPOINT`), SDK retries;
 * - `singleAttempt`: same endpoint, `maxAttempts: 1`, for non-idempotent calls
 *   (`CreateMultipartUpload`, `CompleteMultipartUpload`) so every attempt is
 *   classified by the application, never retried silently by the SDK;
 * - `publicSigner`: only signs URLs for clients (`S3_PUBLIC_ENDPOINT`); the
 *   SigV4 signature is bound to that host.
 */
export interface S3Clients {
  internal: S3Client;
  singleAttempt: S3Client;
  publicSigner: S3Client;
}

export function buildS3Clients(
  config: ConfigType<typeof storageConfig>,
): S3Clients {
  const base: S3ClientConfig = {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // No x-amz-checksum-* parameters in presigned URLs (research finding, TD-04).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: {
      connectionTimeout: STORAGE_TIMEOUTS.CONNECTION_MS,
      requestTimeout: STORAGE_TIMEOUTS.REQUEST_MS,
    },
  };

  return {
    internal: new S3Client({
      ...base,
      endpoint: config.endpoint,
      maxAttempts: STORAGE_RETRY.DEFAULT_MAX_ATTEMPTS,
    }),
    singleAttempt: new S3Client({
      ...base,
      endpoint: config.endpoint,
      maxAttempts: STORAGE_RETRY.SINGLE_ATTEMPT,
    }),
    publicSigner: new S3Client({
      ...base,
      endpoint: config.publicEndpoint,
      maxAttempts: STORAGE_RETRY.SINGLE_ATTEMPT,
    }),
  };
}

export const s3ClientsProvider: Provider = {
  provide: S3_CLIENTS,
  inject: [storageConfig.KEY],
  useFactory: (config: ConfigType<typeof storageConfig>): S3Clients =>
    buildS3Clients(config),
};
