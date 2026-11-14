import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreatePgBossSchema1794452175254 } from './migrations/1794452175254-CreatePgBossSchema';
import { CreateVideos1794453245701 } from './migrations/1794453245701-CreateVideos';
import { AddVideoTitle1794622489462 } from './migrations/1794622489462-AddVideoTitle';
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
const VIDEO_ENUMS = ['video_publication', 'video_processing_status'];

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
    expect(await existingTables(ds(), ['videos'])).toEqual(['videos']);
  });

  it('should revert the videos migration, removing its table and ENUM types', async () => {
    await ds().runMigrations({ transaction: 'each' });

    await ds().undoLastMigration({ transaction: 'each' }); // AddVideoTitle
    await ds().undoLastMigration({ transaction: 'each' });

    expect(await existingTables(ds(), ['videos'])).toEqual([]);
    for (const name of VIDEO_ENUMS) {
      expect(await enumExists(ds(), name)).toBe(false);
    }
    expect(await existingTables(ds(), MANAGED_TABLES)).toEqual(MANAGED_TABLES);
    expect(await queueSchemaExists(ds())).toBe(true);
  });

  it('should revert the pg-boss migration, removing only the queue schema', async () => {
    await ds().runMigrations({ transaction: 'each' });

    await ds().undoLastMigration({ transaction: 'each' }); // AddVideoTitle
    await ds().undoLastMigration({ transaction: 'each' });
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

    await ds().undoLastMigration({ transaction: 'each' }); // AddVideoTitle
    await ds().undoLastMigration({ transaction: 'each' });
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
    await ds().undoLastMigration({ transaction: 'each' }); // AddVideoTitle
    await ds().undoLastMigration({ transaction: 'each' });
    await ds().undoLastMigration({ transaction: 'each' });
    await ds().undoLastMigration({ transaction: 'each' });

    const ran = await ds().runMigrations({ transaction: 'each' });

    expect(ran.map((migration) => migration.name)).toEqual([
      CreateAuthTokens1777579850478.name,
      CreatePgBossSchema1794452175254.name,
      CreateVideos1794453245701.name,
      AddVideoTitle1794622489462.name,
    ]);
    expect(await existingTables(ds(), MANAGED_TABLES)).toEqual(MANAGED_TABLES);
    expect(await queueSchemaExists(ds())).toBe(true);
  });

  describe('AddVideoTitle', () => {
    async function migrateUpToVideos(): Promise<void> {
      await ds().runMigrations({ transaction: 'each' });
      await ds().undoLastMigration({ transaction: 'each' }); // AddVideoTitle
    }

    async function insertLegacyVideo(filename: string): Promise<string> {
      const suffix = Math.random().toString(36).slice(2, 10);
      const [user] = await ds().query<{ id: string }[]>(
        `INSERT INTO "users" ("email", "password")
         VALUES ($1, 'hash') RETURNING id`,
        [`legacy-${suffix}@example.com`],
      );
      const [channel] = await ds().query<{ id: string }[]>(
        `INSERT INTO "channels" ("name", "nickname", "user_id")
         VALUES ('Legacy', $1, $2) RETURNING id`,
        [`legacy${suffix}`, user.id],
      );
      const [video] = await ds().query<{ id: string }[]>(
        `INSERT INTO "videos" ("public_id", "channel_id", "processing_status",
           "idempotency_key", "original_filename", "declared_size_bytes",
           "part_size_bytes", "expected_part_count", "upload_binding_token",
           "upload_expires_at")
         VALUES (substr(md5(random()::text), 1, 11), $1, 'ready', 'k', $2,
           100, 100, 1, 'token', now()) RETURNING id`,
        [channel.id, filename],
      );
      return video.id;
    }

    async function videoRow(
      id: string,
    ): Promise<{ title: string; original_filename: string }> {
      const [row] = await ds().query<
        { title: string; original_filename: string }[]
      >('SELECT "title", "original_filename" FROM "videos" WHERE id = $1', [
        id,
      ]);
      return row;
    }

    it('fills the title of existing rows from the file name and keeps the file name', async () => {
      await migrateUpToVideos();
      const plain = await insertLegacyVideo('Summer holidays.mp4');
      const dotted = await insertLegacyVideo('archive.final.mp4');
      const onlyExtension = await insertLegacyVideo('.mp4');
      const long = await insertLegacyVideo(`${'a'.repeat(120)}.mp4`);

      await ds().runMigrations({ transaction: 'each' });

      expect(await videoRow(plain)).toEqual({
        title: 'Summer holidays',
        original_filename: 'Summer holidays.mp4',
      });
      expect((await videoRow(dotted)).title).toBe('archive.final');
      expect((await videoRow(onlyExtension)).title).toBe('.mp4');
      expect((await videoRow(long)).title).toBe('a'.repeat(100));
    });

    it('makes the title NOT NULL with at most 100 characters', async () => {
      await ds().runMigrations({ transaction: 'each' });

      const [column] = await ds().query<
        { is_nullable: string; character_maximum_length: number }[]
      >(
        `SELECT is_nullable, character_maximum_length
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'videos'
            AND column_name = 'title'`,
      );
      expect(column).toEqual({
        is_nullable: 'NO',
        character_maximum_length: 100,
      });
    });

    it('reverts by dropping only the title column', async () => {
      await migrateUpToVideos();
      const id = await insertLegacyVideo('clip.mp4');
      await ds().runMigrations({ transaction: 'each' });

      await ds().undoLastMigration({ transaction: 'each' });

      const columns = await ds().query<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'videos'
            AND column_name = 'title'`,
      );
      expect(columns).toEqual([]);
      const [row] = await ds().query<{ original_filename: string }[]>(
        'SELECT "original_filename" FROM "videos" WHERE id = $1',
        [id],
      );
      expect(row.original_filename).toBe('clip.mp4');
    });
  });
});
