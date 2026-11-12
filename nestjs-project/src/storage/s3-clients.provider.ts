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
 * The S3 clients of phase-03-videos/TD-04 (identities per the 2026-11-12
 * revision — never the MinIO root user):
 * - `internal`: storage operations from API/worker (`S3_ENDPOINT`), SDK retries,
 *   signed with the process's own identity (API or worker);
 * - `singleAttempt`: same endpoint and identity, `maxAttempts: 1`, for
 *   non-idempotent calls (`CreateMultipartUpload`, `CompleteMultipartUpload`)
 *   so every attempt is classified by the application, never retried silently;
 * - `partSigner`: signs UploadPart URLs for clients (`S3_PUBLIC_ENDPOINT`)
 *   with the process's own identity — the API's, since only it signs parts;
 * - `deliverySigner`: signs playback/download URLs (`S3_PUBLIC_ENDPOINT`) with
 *   the read-only delivery identity; built only when that identity is
 *   configured (the API), so the worker never holds it.
 * SigV4 binds each signature to the host of its endpoint.
 */
export interface S3Clients {
  internal: S3Client;
  singleAttempt: S3Client;
  partSigner: S3Client;
  deliverySigner?: S3Client;
}

export function buildS3Clients(
  config: ConfigType<typeof storageConfig>,
): S3Clients {
  const base: S3ClientConfig = {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    // No x-amz-checksum-* parameters in presigned URLs (research finding, TD-04).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: {
      connectionTimeout: STORAGE_TIMEOUTS.CONNECTION_MS,
      requestTimeout: STORAGE_TIMEOUTS.REQUEST_MS,
    },
  };
  const processIdentity = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };
  const hasDeliveryIdentity =
    config.deliveryAccessKeyId !== '' && config.deliverySecretAccessKey !== '';

  return {
    internal: new S3Client({
      ...base,
      credentials: processIdentity,
      endpoint: config.endpoint,
      maxAttempts: STORAGE_RETRY.DEFAULT_MAX_ATTEMPTS,
    }),
    singleAttempt: new S3Client({
      ...base,
      credentials: processIdentity,
      endpoint: config.endpoint,
      maxAttempts: STORAGE_RETRY.SINGLE_ATTEMPT,
    }),
    partSigner: new S3Client({
      ...base,
      credentials: processIdentity,
      endpoint: config.publicEndpoint,
      maxAttempts: STORAGE_RETRY.SINGLE_ATTEMPT,
    }),
    deliverySigner: hasDeliveryIdentity
      ? new S3Client({
          ...base,
          credentials: {
            accessKeyId: config.deliveryAccessKeyId,
            secretAccessKey: config.deliverySecretAccessKey,
          },
          endpoint: config.publicEndpoint,
          maxAttempts: STORAGE_RETRY.SINGLE_ATTEMPT,
        })
      : undefined,
  };
}

/** Releases every socket of the clients (tests and shutdown). */
export function destroyS3Clients(clients: S3Clients): void {
  clients.internal.destroy();
  clients.singleAttempt.destroy();
  clients.partSigner.destroy();
  clients.deliverySigner?.destroy();
}

export const s3ClientsProvider: Provider = {
  provide: S3_CLIENTS,
  inject: [storageConfig.KEY],
  useFactory: (config: ConfigType<typeof storageConfig>): S3Clients =>
    buildS3Clients(config),
};
