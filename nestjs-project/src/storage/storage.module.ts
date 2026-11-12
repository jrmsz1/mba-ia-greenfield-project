import { Module } from '@nestjs/common';
import { BucketBootstrapService } from './bucket-bootstrap.service';
import { s3ClientsProvider } from './s3-clients.provider';
import { StorageService } from './storage.service';

/** Shared S3 storage for the API and the worker (phase-03-videos/TD-04). */
@Module({
  providers: [s3ClientsProvider, StorageService, BucketBootstrapService],
  exports: [StorageService, BucketBootstrapService],
})
export class StorageModule {}
