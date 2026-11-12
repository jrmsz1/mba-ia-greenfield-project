import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreatePgBossSchema1794452175254 } from './migrations/1794452175254-CreatePgBossSchema';
import {
  createTestDataSource,
  resetTestSchema,
} from '../test/create-test-data-source';
import { TEST_MIGRATIONS } from '../test/test-migrations';
import { testQueueSchema } from '../test/test-queue';

const MANAGED_TABLES = [
  'channels',
  'refresh_tokens',
  'users',
  'verification_tokens',
];
const TOKEN_TABLES = ['refresh_tokens', 'verification_tokens'];
const TOKEN_ENUM = 'verification_tokens_type_enum';

async function existingTables(
  dataSource: DataSource,
  tables: string[],
): Promise<string[]> {
  const rows = await dataSource.query<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [tables],
  );
  return rows.map((row) => row.table_name);
}

async function enumExists(
  dataSource: DataSource,
  name: string,
): Promise<boolean> {
  const rows = await dataSource.query<{ exists: boolean }[]>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typtype = 'e' AND t.typname = $1
     ) AS "exists"`,
    [name],
  );
  return rows[0].exists;
}

async function queueSchemaExists(dataSource: DataSource): Promise<boolean> {
  const rows = await dataSource.query<unknown[]>(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = 'version'`,
    [testQueueSchema()],
  );
  return rows.length > 0;
}

async function recordedMigrations(dataSource: DataSource): Promise<string[]> {
  const rows = await dataSource.query<{ name: string }[]>(
    'SELECT name FROM "migrations" ORDER BY id',
  );
  return rows.map((row) => row.name);
}

describe('Database migrations (integration)', () => {
  let dataSource: DataSource | undefined;

  function ds(): DataSource {
    if (!dataSource?.isInitialized) {
      throw new Error('Test DataSource is not initialized.');
    }
    return dataSource;
  }

  beforeAll(async () => {
    // TestDataSource verifies the target (DB name + server identity) inside
    // initialize() and destroys itself if that check fails.
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken],
      { synchronize: false, migrations: TEST_MIGRATIONS },
    );
    await dataSource.initialize();
  });

  beforeEach(async () => {
    // Each test starts from an empty schema (no tables, no ENUM types).
    await resetTestSchema(ds());
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    try {
      // Leave the shared test DB fully migrated for the suites that follow.
      await dataSource.runMigrations({ transaction: 'each' });
    } finally {
      await dataSource.destroy();
    }
  });

  it('should apply all migrations on an empty schema', async () => {
    const ran = await ds().runMigrations({ transaction: 'each' });

    expect(ran.map((migration) => migration.name)).toEqual(
      TEST_MIGRATIONS.map((migration) => migration.name),
    );
    expect(await existingTables(ds(), MANAGED_TABLES)).toEqual(MANAGED_TABLES);
    expect(await enumExists(ds(), TOKEN_ENUM)).toBe(true);
    expect(await queueSchemaExists(ds())).toBe(true);
  });

  it('should revert the pg-boss migration, removing only the queue schema', async () => {
    await ds().runMigrations({ transaction: 'each' });

    await ds().undoLastMigration({ transaction: 'each' });

    expect(await queueSchemaExists(ds())).toBe(false);
    expect(await existingTables(ds(), MANAGED_TABLES)).toEqual(MANAGED_TABLES);
    expect(await recordedMigrations(ds())).toEqual([
      CreateUsersAndChannels1775687773260.name,
      CreateAuthTokens1777579850478.name,
    ]);
  });

  it('should revert the auth tokens migration, removing its tables and ENUM type', async () => {
    await ds().runMigrations({ transaction: 'each' });

    await ds().undoLastMigration({ transaction: 'each' });
    await ds().undoLastMigration({ transaction: 'each' });

    expect(await existingTables(ds(), TOKEN_TABLES)).toEqual([]);
    expect(await enumExists(ds(), TOKEN_ENUM)).toBe(false);
    expect(await existingTables(ds(), ['channels', 'users'])).toEqual([
      'channels',
      'users',
    ]);
    expect(await recordedMigrations(ds())).toEqual([
      CreateUsersAndChannels1775687773260.name,
    ]);
  });

  it('should re-apply the reverted migrations', async () => {
    await ds().runMigrations({ transaction: 'each' });
    await ds().undoLastMigration({ transaction: 'each' });
    await ds().undoLastMigration({ transaction: 'each' });

    const ran = await ds().runMigrations({ transaction: 'each' });

    expect(ran.map((migration) => migration.name)).toEqual([
      CreateAuthTokens1777579850478.name,
      CreatePgBossSchema1794452175254.name,
    ]);
    expect(await existingTables(ds(), MANAGED_TABLES)).toEqual(MANAGED_TABLES);
    expect(await queueSchemaExists(ds())).toBe(true);
  });
});
