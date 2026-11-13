import { Module } from '@nestjs/common';
import { BucketVerificationService } from './bucket-verification.service';
import { s3ClientsProvider } from './s3-clients.provider';
import { StorageService } from './storage.service';

/** Shared S3 storage for the API and the worker (phase-03-videos/TD-04). */
@Module({
  providers: [s3ClientsProvider, StorageService, BucketVerificationService],
  exports: [StorageService, BucketVerificationService],
})
export class StorageModule {}
