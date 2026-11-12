import { HeadBucketCommand } from '@aws-sdk/client-s3';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import type { S3Clients } from './s3-clients.provider';
import { S3_CLIENTS } from './storage.constants';

/** The configured bucket is missing, inaccessible or denied to this identity. */
export class BucketUnavailableError extends Error {
  constructor(
    readonly bucket: string,
    cause: unknown,
  ) {
    const status = (cause as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    const name = (cause as { name?: string })?.name ?? 'unknown error';
    super(
      `Storage bucket "${bucket}" is not accessible with this process's identity (${status ? `HTTP ${status}, ` : ''}${name}). The bucket is created by the provisioning container, never at startup.`,
    );
    this.name = 'BucketUnavailableError';
  }
}

/**
 * Verifies at startup that the configured bucket exists and is accessible
 * (HeadBucket) and fails fast otherwise. It never creates the bucket: that is
 * done by the ephemeral provisioning container (phase-03-videos/TD-03
 * revision 2026-11-12), and no operational identity may create buckets.
 */
@Injectable()
export class BucketVerificationService implements OnApplicationBootstrap {
  constructor(
    @Inject(S3_CLIENTS) private readonly clients: S3Clients,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.verifyBucket(this.config.bucket);
  }

  async verifyBucket(bucket: string): Promise<void> {
    try {
      await this.clients.internal.send(
        new HeadBucketCommand({ Bucket: bucket }),
      );
    } catch (error) {
      throw new BucketUnavailableError(bucket, error);
    }
  }
}
