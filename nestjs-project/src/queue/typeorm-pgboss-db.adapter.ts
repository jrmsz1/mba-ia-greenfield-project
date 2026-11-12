import type { EntityManager } from 'typeorm';

/**
 * Shape `pg-boss` accepts in the `db` option of `send()` (its `IDatabase`).
 * Declared locally so this file does not load the ESM-only package at runtime.
 */
export interface PgBossDatabase {
  executeSql(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Error raised when the adapter is used outside an active TypeORM transaction.
 * Publishing on the pool instead would silently break the "same transaction"
 * guarantee (phase-03-videos/TD-05), so the adapter refuses it.
 */
export class TransactionRequiredError extends Error {
  constructor() {
    super(
      'fromTypeOrm() requires an EntityManager bound to an active transaction (use it inside dataSource.transaction()).',
    );
    this.name = 'TransactionRequiredError';
  }
}

/**
 * Adapts a TypeORM transactional `EntityManager` to the `executeSql` contract
 * `pg-boss` uses for `send(name, data, { db })`. Every statement pg-boss issues
 * runs on the transaction's own `QueryRunner` connection, so the job insert
 * commits or rolls back together with the caller's writes
 * (phase-03-videos/TD-05, Verification Gate 1).
 */
export function fromTypeOrm(manager: EntityManager): PgBossDatabase {
  const runner = manager.queryRunner;
  if (!runner || !runner.isTransactionActive) {
    throw new TransactionRequiredError();
  }

  return {
    async executeSql(text, values) {
      if (!runner.isTransactionActive) {
        throw new TransactionRequiredError();
      }
      const result = await runner.query(text, values, true);
      return { rows: (result.records ?? []) as Record<string, unknown>[] };
    },
  };
}
