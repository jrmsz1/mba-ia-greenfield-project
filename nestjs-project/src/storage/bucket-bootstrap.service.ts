import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import type { S3Clients } from './s3-clients.provider';
import { classifyStorageError } from './storage-errors';
import { S3_CLIENTS } from './storage.constants';

/**
 * Creates the configured bucket at startup when it does not exist; the
 * application owns this step, there is no `mc` sidecar (phase-03-videos/TD-03).
 */
@Injectable()
export class BucketBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BucketBootstrapService.name);

  constructor(
    @Inject(S3_CLIENTS) private readonly clients: S3Clients,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureBucket(this.config.bucket);
  }

  async ensureBucket(bucket: string): Promise<void> {
    try {
      await this.clients.internal.send(
        new HeadBucketCommand({ Bucket: bucket }),
      );
      return;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status !== 404) throw classifyStorageError(error);
    }
    try {
      await this.clients.internal.send(
        new CreateBucketCommand({ Bucket: bucket }),
      );
      this.logger.log(`Created bucket ${bucket}`);
    } catch (error) {
      const code = (error as { name?: string }).name;
      if (code === 'BucketAlreadyOwnedByYou') return;
      throw classifyStorageError(error);
    }
  }
}
