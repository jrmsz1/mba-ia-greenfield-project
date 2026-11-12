import type { DataSource } from 'typeorm';
import {
  TEST_RESOURCE_PATTERNS,
  VIDEO_ENV_DEFAULTS,
} from '../config/video.constants';
import { pgBossSchemaSql } from '../queue/pgboss-schema';
import { assertConnectedToTestDatabase } from './test-database';

export class TestQueueGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestQueueGuardError';
  }
}

/** Refuses any pg-boss schema that is not a test schema (phase-03-videos/TD-15). */
export function assertTestQueueSchema(schema: string): void {
  if (!TEST_RESOURCE_PATTERNS.PGBOSS_SCHEMA.test(schema)) {
    throw new TestQueueGuardError(
      `Refusing to touch pg-boss schema "${schema}" in tests: test schemas must match ${TEST_RESOURCE_PATTERNS.PGBOSS_SCHEMA.source}.`,
    );
  }
}

export function testQueueSchema(env: NodeJS.ProcessEnv = process.env): string {
  const schema =
    env.PGBOSS_TEST_SCHEMA?.trim() || VIDEO_ENV_DEFAULTS.PGBOSS_TEST_SCHEMA;
  assertTestQueueSchema(schema);
  return schema;
}

/**
 * Points PGBOSS_SCHEMA at PGBOSS_TEST_SCHEMA (mirrors applyTestDatabaseEnv for
 * DB_NAME), so the migration and anything booting the QueueModule in tests
 * use the test schema only.
 */
export function applyTestQueueEnv(env: NodeJS.ProcessEnv = process.env): void {
  env.PGBOSS_SCHEMA = testQueueSchema(env);
}

/** Drops the test queue schema (refuses any other schema). */
export async function dropTestQueueSchema(
  dataSource: DataSource,
  schema: string = testQueueSchema(),
): Promise<void> {
  assertTestQueueSchema(schema);
  await assertConnectedToTestDatabase(dataSource);
  await dataSource.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

/** Drops and recreates the test queue schema from pg-boss's construction plan. */
export async function resetTestQueueSchema(
  dataSource: DataSource,
  schema: string = testQueueSchema(),
): Promise<void> {
  await dropTestQueueSchema(dataSource, schema);
  await dataSource.transaction(async (manager) => {
    await manager.query(pgBossSchemaSql(schema));
  });
}
