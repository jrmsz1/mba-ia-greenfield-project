import 'dotenv/config';
import { DataSource, type QueryRunner } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { createTestDataSource } from './create-test-data-source';
import { applyTestQueueEnv, dropTestQueueSchema } from './test-queue';
import {
  assertAuthorizedServer,
  readTestDatabaseConfig,
  TEST_DATABASE_NAME_PATTERN,
  TestDatabaseGuardError,
} from './test-database';
import {
  assertMigrationListIsComplete,
  TEST_MIGRATIONS,
} from './test-migrations';

// Entities are registered so the driver installs `uuid-ossp`, which the
// migrations rely on (`uuid_generate_v4()`).
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken];
const MAINTENANCE_DATABASE = 'postgres';

/** Exclusive ownership of the test database for one test run. */
export interface TestRunLock {
  release(): Promise<void>;
}

/**
 * Takes a session-level advisory lock keyed by the test database name. The
 * session is a QueryRunner that stays checked out of the pool for the whole
 * run (an idle pooled client would be discarded after pg's idleTimeoutMillis,
 * silently dropping the lock). A second concurrent run fails fast instead of
 * resetting the database under the first one. PostgreSQL releases the lock
 * automatically if the holding process dies.
 */
async function acquireTestRunLock(
  session: QueryRunner,
  database: string,
): Promise<void> {
  const rows = (await session.query(
    'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
    [database],
  )) as { locked: boolean }[];
  if (!rows[0]?.locked) {
    throw new TestDatabaseGuardError(
      `Another test run is using "${database}" (advisory lock held). Wait for it to finish; concurrent runs would reset each other's data.`,
    );
  }
}

/**
 * Locks, creates (if missing), resets and migrates the test database.
 *
 * Order of checks: server identity on the maintenance connection → advisory
 * lock → CREATE DATABASE; then test database name + server identity (by
 * `TestDataSource.initialize()`) → reset → migrations. Nothing outside
 * DB_TEST_NAME is modified. The caller must `release()` the returned lock.
 */
export async function prepareTestDatabase(): Promise<TestRunLock> {
  const config = readTestDatabaseConfig();
  assertMigrationListIsComplete();

  const maintenance = new DataSource({
    type: 'postgres',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: MAINTENANCE_DATABASE,
    synchronize: false,
  });
  await maintenance.initialize();
  const session = maintenance.createQueryRunner();
  const lock: TestRunLock = {
    release: async () => {
      if (!session.isReleased) await session.release();
      if (maintenance.isInitialized) await maintenance.destroy();
    },
  };

  try {
    await session.connect();
    await assertAuthorizedServer(maintenance, config);
    await acquireTestRunLock(session, config.database);

    const existing = (await session.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [config.database],
    )) as unknown[];
    if (existing.length === 0) {
      // Identifiers cannot be bound as parameters; the name was validated
      // against TEST_DATABASE_NAME_PATTERN (lowercase alnum + "_" only).
      if (!TEST_DATABASE_NAME_PATTERN.test(config.database)) {
        throw new TestDatabaseGuardError(
          `Refusing to create "${config.database}".`,
        );
      }
      await session.query(`CREATE DATABASE "${config.database}"`);
    }

    const testDataSource = createTestDataSource(ALL_ENTITIES, {
      synchronize: false,
      migrations: TEST_MIGRATIONS,
    });
    // TestDataSource.initialize() verifies database name + server identity.
    await testDataSource.initialize();
    try {
      // Reset to a known state: residue from an interrupted run (tables
      // created by synchronize, orphan ENUM types, partial migration history)
      // would otherwise make every later run fail. clearDatabase drops views,
      // tables and ENUM types but keeps extensions (uuid-ossp).
      await testDataSource.dropDatabase();
      // The pg-boss migration creates PGBOSS_SCHEMA; point it at the test
      // queue schema and drop that schema first (clearDatabase only clears
      // the public schema), so every run starts with an empty queue.
      applyTestQueueEnv(process.env);
      await dropTestQueueSchema(testDataSource);
      await testDataSource.runMigrations({ transaction: 'each' });
    } finally {
      await testDataSource.destroy();
    }
  } catch (error) {
    await lock.release();
    throw error;
  }

  return lock;
}

if (require.main === module) {
  prepareTestDatabase()
    .then((lock) => lock.release())
    .then(
      () => console.log('Test database is ready.'),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
}
