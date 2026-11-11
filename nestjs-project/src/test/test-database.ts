import type { DataSource } from 'typeorm';

/**
 * Safety guard for every test that touches PostgreSQL.
 *
 * Tests are destructive (DELETE, DROP TABLE, synchronize). They must only ever
 * run against a dedicated `*_test` database on the PostgreSQL server that was
 * explicitly authorized via `DB_TEST_SERVER_ID`. There is no fallback: any
 * missing or inconsistent value aborts the run.
 */

export const TEST_DATABASE_NAME_PATTERN = /^[a-z][a-z0-9_]*_test$/;
const SERVER_SYSTEM_ID_PATTERN = /^\d+$/;

export class TestDatabaseGuardError extends Error {
  constructor(message: string) {
    super(`[test-database-guard] ${message}`);
    this.name = 'TestDatabaseGuardError';
  }
}

export interface TestDatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  /** `system_identifier` from `pg_control_system()` of the authorized server. */
  serverSystemId: string;
}

const SERVER_ID_HINT =
  'Get it with: docker compose exec db psql -U streamtube -d postgres -Atc "SELECT system_identifier FROM pg_control_system()"';

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    const hint = key === 'DB_TEST_SERVER_ID' ? ` ${SERVER_ID_HINT}` : '';
    throw new TestDatabaseGuardError(
      `${key} must be set (see .env.example). Refusing to run tests without an explicit test database target.${hint}`,
    );
  }
  return value;
}

export function readTestDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): TestDatabaseConfig {
  const database = requireEnv(env, 'DB_TEST_NAME');
  if (!TEST_DATABASE_NAME_PATTERN.test(database)) {
    throw new TestDatabaseGuardError(
      `DB_TEST_NAME="${database}" must match ${TEST_DATABASE_NAME_PATTERN} (lowercase, ending in "_test").`,
    );
  }

  // Per-machine value (changes whenever the PostgreSQL data directory is
  // re-initialized), so it lives only in the developer's untracked .env.
  // Obtain it with: docker compose exec db psql -U streamtube -d postgres -Atc
  //   "SELECT system_identifier FROM pg_control_system()"
  const serverSystemId = requireEnv(env, 'DB_TEST_SERVER_ID');
  if (!SERVER_SYSTEM_ID_PATTERN.test(serverSystemId)) {
    throw new TestDatabaseGuardError(
      `DB_TEST_SERVER_ID="${serverSystemId}" must be the numeric system_identifier of the authorized PostgreSQL server.`,
    );
  }

  const rawPort = requireEnv(env, 'DB_PORT');
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0) {
    throw new TestDatabaseGuardError(`DB_PORT="${rawPort}" is not a port.`);
  }

  return {
    host: requireEnv(env, 'DB_HOST'),
    port,
    username: requireEnv(env, 'DB_USERNAME'),
    password: requireEnv(env, 'DB_PASSWORD'),
    database,
    serverSystemId,
  };
}

/**
 * Points `DB_NAME` (read by `databaseConfig` / `AppModule`) at the test
 * database for the current Jest environment. Runs from `setupFiles`, so every
 * test that boots `AppModule` connects to the test database.
 */
export function applyTestDatabaseEnv(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const config = readTestDatabaseConfig(env);
  const appDatabase = env.DB_NAME?.trim();
  if (appDatabase && appDatabase !== config.database) {
    // DB_NAME is the development database; it is never a valid test target.
    if (TEST_DATABASE_NAME_PATTERN.test(appDatabase)) {
      throw new TestDatabaseGuardError(
        `DB_NAME="${appDatabase}" and DB_TEST_NAME="${config.database}" are both test databases; the target is ambiguous.`,
      );
    }
  }
  env.DB_NAME = config.database;
}

async function queryServerIdentity(
  dataSource: DataSource,
): Promise<{ database: string; systemIdentifier: string }> {
  const rows = await dataSource.query<
    { database: string; system_identifier: string }[]
  >(
    `SELECT current_database() AS database,
            (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier`,
  );
  const row = rows[0];
  if (!row?.database || !row.system_identifier) {
    throw new TestDatabaseGuardError(
      'Could not read the connected database identity; refusing to continue.',
    );
  }
  return { database: row.database, systemIdentifier: row.system_identifier };
}

/** Verifies the effective connection is on the authorized PostgreSQL server. */
export async function assertAuthorizedServer(
  dataSource: DataSource,
  expected: TestDatabaseConfig = readTestDatabaseConfig(),
): Promise<void> {
  const { systemIdentifier } = await queryServerIdentity(dataSource);
  if (systemIdentifier !== expected.serverSystemId) {
    throw new TestDatabaseGuardError(
      `Connected server system_identifier=${systemIdentifier} does not match DB_TEST_SERVER_ID=${expected.serverSystemId}.`,
    );
  }
}

/**
 * Verifies the effective connection is the test database on the authorized
 * server. Must run before any destructive operation or schema synchronization.
 */
export async function assertConnectedToTestDatabase(
  dataSource: DataSource,
  expected: TestDatabaseConfig = readTestDatabaseConfig(),
): Promise<void> {
  const { database, systemIdentifier } = await queryServerIdentity(dataSource);
  if (
    database !== expected.database ||
    !TEST_DATABASE_NAME_PATTERN.test(database)
  ) {
    throw new TestDatabaseGuardError(
      `Connected to database "${database}", expected "${expected.database}".`,
    );
  }
  if (systemIdentifier !== expected.serverSystemId) {
    throw new TestDatabaseGuardError(
      `Connected server system_identifier=${systemIdentifier} does not match DB_TEST_SERVER_ID=${expected.serverSystemId}.`,
    );
  }
}
