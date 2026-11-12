import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JobPublisherService } from '../queue/job-publisher.service';
import { PGBOSS } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { WorkerModule, workerDatabaseModule } from './worker.module';

/** Stands in for the TypeORM root: the compile test needs no database. */
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: {} }],
  exports: [DataSource],
})
class NoDatabaseModule {}

describe('WorkerModule', () => {
  it('should compile with storage and the worker-role queue, without an HTTP server', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideModule(workerDatabaseModule)
      .useModule(NoDatabaseModule)
      .compile();

    expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);
    expect(moduleRef.get(JobPublisherService)).toBeInstanceOf(
      JobPublisherService,
    );
    expect(moduleRef.get(PGBOSS)).toBeDefined();
    await moduleRef.close();
  });
});
