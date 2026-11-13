import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationInterface } from 'typeorm';
import { CreateUsersAndChannels1775687773260 } from '../database/migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from '../database/migrations/1777579850478-CreateAuthTokens';
import { CreatePgBossSchema1794452175254 } from '../database/migrations/1794452175254-CreatePgBossSchema';
import { CreateVideos1794453245701 } from '../database/migrations/1794453245701-CreateVideos';

/**
 * Explicit migration list for test DataSources (ts-jest cannot load TypeORM
 * globs). Keep in sync with `src/database/migrations/`; enforced by
 * `assertMigrationListIsComplete()`.
 */
export const TEST_MIGRATIONS: (new () => MigrationInterface)[] = [
  CreateUsersAndChannels1775687773260,
  CreateAuthTokens1777579850478,
  CreatePgBossSchema1794452175254,
  CreateVideos1794453245701,
];

const MIGRATIONS_DIR = join(__dirname, '..', 'database', 'migrations');

export function assertMigrationListIsComplete(): void {
  const onDisk = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => {
      const [timestamp, name] = file.replace(/\.ts$/, '').split('-');
      return `${name}${timestamp}`;
    })
    .sort();
  const listed = TEST_MIGRATIONS.map((migration) => migration.name).sort();

  if (JSON.stringify(onDisk) !== JSON.stringify(listed)) {
    throw new Error(
      `TEST_MIGRATIONS is out of sync with src/database/migrations. On disk: [${onDisk.join(', ')}]; listed: [${listed.join(', ')}].`,
    );
  }
}
