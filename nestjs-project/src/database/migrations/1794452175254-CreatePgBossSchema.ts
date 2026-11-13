import { MigrationInterface, QueryRunner } from 'typeorm';
import { VIDEO_ENV_DEFAULTS } from '../../config/video.constants';
import {
  assertQueueSchemaName,
  pgBossSchemaSql,
} from '../../queue/pgboss-schema';

/**
 * Creates the pg-boss schema deterministically from the library's own
 * construction plan (phase-03-videos/TD-05, Verification Gate 1 selection).
 * The application starts pg-boss with `migrate: false`, so this migration is
 * the only place the queue schema is created. Hand-written: the TypeORM CLI
 * cannot generate library-owned DDL.
 *
 * Idempotent: an existing pg-boss schema (its `version` table) is left as is.
 * The schema name comes from PGBOSS_SCHEMA (the test harness points it at
 * PGBOSS_TEST_SCHEMA).
 */
export class CreatePgBossSchema1794452175254 implements MigrationInterface {
  name = 'CreatePgBossSchema1794452175254';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = queueSchema();
    const existing = (await queryRunner.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'version'`,
      [schema],
    )) as unknown[];
    if (existing.length > 0) return;
    await queryRunner.query(pgBossSchemaSql(schema));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = queueSchema();
    await queryRunner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
}

function queueSchema(): string {
  const schema = process.env.PGBOSS_SCHEMA || VIDEO_ENV_DEFAULTS.PGBOSS_SCHEMA;
  assertQueueSchemaName(schema);
  return schema;
}
