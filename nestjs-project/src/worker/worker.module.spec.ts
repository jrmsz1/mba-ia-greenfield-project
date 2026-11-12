import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JobPublisherService } from '../queue/job-publisher.service';
import { PGBOSS } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';

/**
 * The worker never holds the delivery identity and its schema forbids it
 * (phase-03-videos/TD-16 revision 2026-11-12); this test may run inside the
 * API process, which does hold it, so the module is loaded from a
 * worker-shaped environment. Config validation runs at import (forRoot).
 */
const DELIVERY_KEYS = [
  'S3_DELIVERY_ACCESS_KEY_ID',
  'S3_DELIVERY_SECRET_ACCESS_KEY',
] as const;

function loadWorkerModule(): typeof import('./worker.module') {
  const saved = DELIVERY_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of DELIVERY_KEYS) delete process.env[key];
  try {
    // Deferred require: nothing else in this file imports worker.module, so
    // its forRoot() validation runs here, without the delivery identity.
    return jest.requireActual<typeof import('./worker.module')>(
      './worker.module',
    );
  } finally {
    for (const [key, value] of saved) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

/** Stands in for the TypeORM root: the compile test needs no database. */
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: {} }],
  exports: [DataSource],
})
class NoDatabaseModule {}

describe('WorkerModule', () => {
  it('should compile with storage and the worker-role queue, without an HTTP server', async () => {
    const { WorkerModule, workerDatabaseModule } = loadWorkerModule();
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
