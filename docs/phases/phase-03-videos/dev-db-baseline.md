# Dev database migration baseline (SI-03.12 unblock)

**Date:** 2026-11-12 · **Authorized by:** user, option "Baseline, keep data", with conditions: verifiable backup, identity check, no destructive operation, stop on any divergence.

## Problem

The development database `streamtube` had been built by the old `synchronize` setup. It held `users`, `channels`, `refresh_tokens` and `verification_tokens`, but the `migrations` table was empty. So `migration:run` failed ("relation channels already exists"), the pg-boss schema was never installed, and the worker exited with `pg-boss is not installed`.

## Steps and evidence

| Step | Evidence |
|---|---|
| Target identity | `current_database()` = `streamtube`; the server `system_identifier` equals the one configured locally (value not recorded) |
| Backup | `pg_dump -Fc` → `streamtube-pre-baseline.dump`, SHA-256 `7eaf1dcda77ff70ac279addb9a844daf6742c79898084d3da0f538511c524ada`, identical in the container and the host copy (session scratchpad) |
| Backup restorable | `pg_restore --exit-on-error` into the new database `streamtube_backup_verify` → OK. Same row counts (1/0/0/0) and same content hash of `users` (`8a691d3c…`) as the source |
| Structural equivalence | `pg_dump --schema-only` of the 4 tables plus enum labels and extensions, dev vs the migration-built test DB. Only difference: pg_dump's random `\restrict` session token. The `migrations` table structure is identical. Dev holds no other object (only the PK/UQ/indexes/enum created by `CreateUsersAndChannels` + `CreateAuthTokens`). The later migrations do not alter these tables |
| Baseline | One guarded transaction (aborts unless the database is `streamtube`, `migrations` is empty, the auth tables exist and `videos` does not) inserts only `CreateUsersAndChannels1775687773260` and `CreateAuthTokens1777579850478`. `--fake` was not used: it would also mark the pg-boss and videos migrations as run |
| Remaining migrations | `npm run migration:run` (official mechanism) → `CreatePgBossSchema`, `CreateVideos` executed. `migration:show` → 4/4 `[X]` |
| Data preserved | Same counts and `users` content hash after the migration and after the full regression |
| pg-boss | `pgboss.version` = 46; queues `video.process` and `video.reconcile` with policy `exclusive` |
| API boot | compiled API on the dev DB: `GET /` → 200 `Hello World!`; `POST /videos/:id/upload/complete` without a token → 401; then stopped |
| Worker boot | `docker compose up -d worker` → running, no published port, uid 10001, "Video worker started"; `docker compose stop worker` → exit 0 in 850 ms, 0 active jobs |
| Regression | npm test 54 suites / 381; test:e2e 6 suites / 83; tsc 0; eslint baseline |

No DROP, TRUNCATE, `synchronize: true` or schema reset was run on `streamtube`.

## Left for the user

- `streamtube_backup_verify`, the backup verification copy, still exists on the server. It was not dropped, per the "no DROP" condition. Remove it when no longer needed.
- The dump file lives in the session scratchpad. Copy it somewhere durable if you want to keep it.
- The worker's bucket bootstrap created the dev bucket (`S3_BUCKET`) in MinIO on its first boot. That is the expected application behavior.
