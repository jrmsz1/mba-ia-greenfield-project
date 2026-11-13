import { getConstructionPlans } from 'pg-boss';
import { QUEUE_SCHEMA_PATTERN } from './queue.constants';

export function assertQueueSchemaName(schema: string): void {
  if (!QUEUE_SCHEMA_PATTERN.test(schema)) {
    throw new Error(
      `Invalid pg-boss schema name "${schema}": must match ${QUEUE_SCHEMA_PATTERN.source}.`,
    );
  }
}

/**
 * pg-boss's construction DDL for `schema`, without the `BEGIN;` / `COMMIT;`
 * that wrap it, so it runs inside the caller's transaction (a TypeORM
 * migration). The advisory lock and `SET LOCAL` statements inside it keep
 * their effect within that transaction. Fails loudly if a future pg-boss
 * version changes the wrapping, instead of running it half-transactional.
 */
export function pgBossSchemaSql(schema: string): string {
  assertQueueSchemaName(schema);
  const ddl = getConstructionPlans(schema).trim();
  if (!ddl.startsWith('BEGIN;') || !ddl.endsWith('COMMIT;')) {
    throw new Error(
      'Unexpected pg-boss construction plan format: expected a single BEGIN;…COMMIT; block.',
    );
  }
  return ddl.slice('BEGIN;'.length, -'COMMIT;'.length);
}
