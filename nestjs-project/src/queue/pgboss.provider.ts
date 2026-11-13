import type { Provider } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PgBoss } from 'pg-boss';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import { assertQueueSchemaName } from './pgboss-schema';
import { PGBOSS, QUEUE_MODULE_OPTIONS } from './queue.constants';

export interface QueueModuleOptions {
  /**
   * `api` only publishes (no supervision, no schedules); `worker` consumes,
   * supervises expired/abandoned jobs and runs schedules (phase-03-videos/TD-06).
   */
  role: 'api' | 'worker';
}

export function createPgBoss(
  db: ConfigType<typeof databaseConfig>,
  queue: ConfigType<typeof queueConfig>,
  options: QueueModuleOptions,
): PgBoss {
  assertQueueSchemaName(queue.schema);
  const isWorker = options.role === 'worker';
  return new PgBoss({
    host: db.host,
    port: db.port,
    user: db.username,
    password: db.password,
    database: db.name,
    schema: queue.schema,
    // The schema is created only by the CreatePgBossSchema migration.
    migrate: false,
    supervise: isWorker,
    schedule: isWorker,
  });
}

export const pgBossProvider: Provider = {
  provide: PGBOSS,
  inject: [databaseConfig.KEY, queueConfig.KEY, QUEUE_MODULE_OPTIONS],
  useFactory: (
    db: ConfigType<typeof databaseConfig>,
    queue: ConfigType<typeof queueConfig>,
    options: QueueModuleOptions,
  ): PgBoss => createPgBoss(db, queue, options),
};
