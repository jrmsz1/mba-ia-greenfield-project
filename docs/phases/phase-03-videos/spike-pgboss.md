# SI-03.1 — Spike: pg-boss × TypeORM (Verification Gate 1)

**Date:** 2026-11-11
**Branch:** `feature/phase-03-videos`
**Gate 1 result:** **PASS** — approved by the user on 2026-11-11. Recorded in `progress.md` (gates table); the planning snapshot in `context.md` is not edited.

## Versions

| Component | Version | Notes |
|---|---|---|
| Node.js (container `nestjs-api`) | 25.6.0 | pg-boss 12.38.2 requires Node ≥ 22.12 |
| `pg-boss` | 12.38.2 (`^12.38.2`) | ESM-only package (`"type": "module"`) |
| `pg` | 8.23.1 (`^8.23.1`, upgraded from 8.20.0) | pg-boss requires `pg ^8.23.1` |
| `typeorm` | 0.3.28 | unchanged |
| `@nestjs/typeorm` | 11.0.1 | unchanged |
| PostgreSQL | 17 (Compose service `db`) | test database `DB_TEST_NAME` |
| TypeScript / Jest | 5.9.3 / 30.2.0 | unchanged |

## How pg-boss uses the TypeORM transaction

`send(name, data, { db })` runs its `INSERT` on whatever object it receives, provided it implements `executeSql(text, values)`. It issues no `BEGIN`/`COMMIT` of its own. pg-boss documents adapters only for Knex, Kysely, Drizzle, Prisma, Bun SQL and PGlite; **there is no TypeORM adapter**.

`src/queue/typeorm-pgboss-db.adapter.ts` → `fromTypeOrm(manager)` adapts the transactional `EntityManager` given by `dataSource.transaction(async (manager) => …)`:

- it uses `manager.queryRunner`, the single connection that holds the open transaction, and calls `queryRunner.query(text, values, true)`; the structured result's `records` become `{ rows }`;
- it refuses an `EntityManager` without an active transaction (`TransactionRequiredError`), so a job can never be published silently on the pool outside the caller's transaction.

Proof that the insert really runs inside the transaction: in the commit test, a lookup through pg-boss's own pool, made **inside** the transaction right after `send`, does not find the job (uncommitted). After the commit it does.

## Schema initialization mechanism (selected)

**DDL from `getConstructionPlans(schema)`, applied by our own code, with pg-boss started with `migrate: false`.** It is deterministic (identical output for the same schema, asserted by the test) and can be reviewed and applied by a TypeORM migration. In the spike it is applied by `dataSource.query(getConstructionPlans(schema))`. The production migration and the `QueueModule` belong to SI-03.5. The alternative (letting `boss.start()` create and migrate the schema) was not selected because it hides the DDL from the migration history.

## Results per TD-05 condition

| # | Condition | Result | Evidence (test in `src/queue/pgboss-spike.integration-spec.ts`) |
|---|---|---|---|
| 1 | pg-boss compatible with the installed TypeORM and `pg` | PASS | `pg` upgraded to 8.23.1; full regression green: `npm test` 28 suites / 206 tests, `npm run test:e2e` 3 suites / 52 tests, `tsc --noEmit` exit 0 |
| 2 | `send(…, { db })` enqueues inside the same transaction as the state change | PASS | "commit keeps both the state change and the job" (job invisible to the pool before commit) |
| 3 | Rollback publishes no job | PASS | "rollback discards both the state change and the job": `send` returned an id, the transaction threw, then 0 rows and 0 jobs |
| 4 | Commit keeps both the video state and the job | PASS | same commit test: 1 row + 1 job with `data.videoId` and `singletonKey` |
| 5 | `pgboss` schema initialized deterministically | PASS | "produces the same DDL…", "starts pg-boss with migrate: false on a schema created only from getConstructionPlans()" |
| 6 | Schema isolated and reset in tests | PASS | schema `PGBOSS_TEST_SCHEMA` (default `pgboss_test`) inside the guarded test database; "refuses to reset a schema that is not a test schema" (`pgboss` rejected before any DDL) |
| 7 | Dedupe by key, retries with backoff, heartbeat/recovery of interrupted jobs | PASS | "a second send with the same singletonKey creates no second job"; "a failed job is retried with a growing backoff delay"; "a job claimed by a worker killed with SIGKILL is recovered and delivered again" (real child process, `SIGKILL`, `expireInSeconds: 1`, `supervise()` → `retry` → re-fetched, `retryCount` 1) |
| 8 | No database transaction open while a video is processed | PASS | "the worker handler runs with no open transaction on any connection" (`pg_stat_activity` shows 0 `idle in transaction` sessions while the handler runs; the claim is a single autocommit statement) |

Repeatability: the spike suite passed 4 consecutive times (10/10 each), including the time-dependent `SIGKILL` test.

## Findings that bind later SIs (no decision changed)

1. **ESM-only package under Jest.** The application runs on Node 25, where CommonJS `require()` of an ESM package works natively (checked with `node -e "require('pg-boss')"` in the container), and `tsc` with `module: nodenext` (TS 5.9) accepts the import. Jest's own module registry cannot evaluate the package ("Cannot use import statement outside a module"). Fix: `src/test/pg-boss-native.cjs` loads pg-boss through Node's native `require` (`process.getBuiltinModule('node:module').createRequire`), mapped by `moduleNameMapper` in the `integration` Jest project. `process.getBuiltinModule` is required, because Jest's substituted `node:module` re-enters its registry and returned the shim's own empty exports. **SI-03.5 must add the same mapping to the `unit` project and to `test/jest-e2e.json`** when the `QueueModule` is loaded there.
2. **Queue policy.** `singletonKey` alone does **not** dedupe on the default `standard` policy (observed: a second job was created). The `video.process` queue must be created with policy **`exclusive`** (at most one queued-or-active job per `singletonKey`). SI-03.5 creates it this way. This is what makes the reconciler's re-publication (SI-03.15) harmless.
3. **`retryCount` semantics.** pg-boss increments `retryCount` when a job is **claimed again**, not when it fails. Every claim is fenced by `id:retry_count`, so a stale worker whose claim lapsed cannot complete or fail the newer attempt. This matches the idempotency rules of TD-09.
4. **Recovery timing.** An interrupted job is recovered only when its `expireInSeconds` has elapsed **and** a supervise pass runs. SI-03.5 / SI-03.14 must derive `expireInSeconds` from `WORKER_JOB_TIMEOUT_SECONDS` and keep the supervisor enabled in the worker.

## Limitations and risks

- **The production load path is not yet exercised under Nest.** Only `require(esm)` and `tsc` were proven. Booting the Nest application with the `QueueModule` is SI-03.5 (its module compilation test).
- **Two `pg` instances in tests.** Under Jest, pg-boss and its own `pg` are loaded natively, outside Jest's registry, while TypeORM uses the Jest-loaded `pg`. Each keeps its own pool. This is harmless for the spike, but `jest.mock('pg-boss')` would not work. The plan does not mock pg-boss.
- **Jest coupling.** The shim depends on `process.getBuiltinModule` (Node ≥ 22.3) and on Jest's `moduleNameMapper`. If Jest gains native ESM support, the shim can be removed.
- **Pre-existing deprecation warning (out of scope).** `pg 8.23` warns "Calling client.query() when the client is already executing a query". The trace points to TypeORM's `PostgresQueryRunner.clearDatabase` (`Promise.all` on one client), called by the existing `src/test/prepare-test-database.ts` global setup, not to pg-boss. It becomes an error in `pg@9`.
- **Partial resolution of TD-05 condition (7) "heartbeat".** Recovery after a crash was proven through `expireInSeconds`. Heartbeat-based detection (`heartbeatSeconds`) was not exercised; SI-03.14 decides whether to use it.

## Test isolation

- Database: the guarded test database only (`DB_TEST_NAME` + `DB_TEST_SERVER_ID` checks from `src/test/test-database.ts`, through `createTestDataSource`).
- pg-boss schema: `PGBOSS_TEST_SCHEMA` (default `pgboss_test`), must match `^[a-z][a-z0-9_]*_test$`; any other name is refused before any DDL. It is dropped and recreated in `beforeAll` and dropped in `afterAll`.
- Spike table: `pgboss_spike_videos`, created in the test database and dropped in `afterAll`.
- Integration runs stay serial (`maxWorkers: 1`).

## Reproduce

From `nestjs-project/` (every command runs inside the container):

```bash
docker compose up -d db
docker compose exec nestjs-api npm install
docker compose exec nestjs-api npx jest --selectProjects integration --testPathPatterns src/queue/pgboss-spike.integration-spec.ts
docker compose exec nestjs-api npm test
docker compose exec nestjs-api npm run test:e2e
docker compose exec nestjs-api npx tsc --noEmit
```

## Fallback status

Conditions (2)–(4) passed, so the TD-05 fallback (outbox/reconciliation with the `uploaded` row as durable intent) is **not** needed. SI-03.5 follows the transactional path. The reconciler of SI-03.15 keeps its role for queue-publish failures and interrupted jobs.
