import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JobPublisherService } from '../queue/job-publisher.service';
import { PGBOSS } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';

/**
 * Compile test only: the module is loaded from a fictitious, worker-shaped
 * environment (its own identity, no delivery identity — which the worker
 * schema forbids, phase-03-videos/TD-16). It must not depend on the
 * credentials of whatever container runs it: the ephemeral test containers
 * hold only the restricted test identities, the API holds the delivery one.
 * Config validation runs at import (forRoot).
 */
const WORKER_SHAPED_ENV: Record<string, string | undefined> = {
  S3_ACCESS_KEY_ID: 'compile-test-worker-id',
  S3_SECRET_ACCESS_KEY: 'compile-test-worker-secret',
  S3_DELIVERY_ACCESS_KEY_ID: undefined,
  S3_DELIVERY_SECRET_ACCESS_KEY: undefined,
};

function loadWorkerModule(): typeof import('./worker.module') {
  const saved = Object.keys(WORKER_SHAPED_ENV).map(
    (key) => [key, process.env[key]] as const,
  );
  for (const [key, value] of Object.entries(WORKER_SHAPED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    // Deferred require: nothing else in this file imports worker.module, so
    // its forRoot() validation runs here, without the delivery identity.
    return jest.requireActual<typeof import('./worker.module')>(
      './worker.module',
    );
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
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
