# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 7/17 completed

## Required Technical Verification Gates

_Execution status of the 8 gates listed in context.md → Testing Requirements (that table is the planning snapshot and stays PENDING; editing it would invalidate validation.md). A gate is PASS only with executed evidence and human approval._

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | TypeORM + pg-boss transactional integration (TD-05) | PASS — approved 2026-11-11 | docs/phases/phase-03-videos/spike-pgboss.md; src/queue/pgboss-spike.integration-spec.ts |
| 2 | Pinned MinIO image, SHA-256, Compose, healthcheck, CORS (TD-03, TD-16) | PASS — evidence executed 2026-11-11 (minisign/ARM64 preserved as options, not exercised) | docs/phases/phase-03-videos/gate-02-minio.md |
| 3 | 10 GiB upload end to end (TD-01, TD-08, TD-13) | PENDING | — |
| 4 | Ambiguous completion: identity and integrity proof (TD-02) | PENDING | — |
| 5 | Concurrent completions (TD-02, TD-09) | PENDING | — |
| 6 | Real media fixtures (TD-07, TD-15) | PENDING | — |
| 7 | Presigned URL expiry and renewal (TD-11) | PENDING | — |
| 8 | HTTP Range directly on MinIO (TD-11) | PENDING | — |

### SI-03.1 — Spike: pg-boss × TypeORM (Verification Gate 1)
- **Status:** completed
- **Tests:** 10 passing (src/queue/pgboss-spike.integration-spec.ts, 4 consecutive runs); regression: npm test 206 passing, test:e2e 52 passing, tsc exit 0, eslint baseline unchanged
- **Observations:**
  - Gate 1 PASS approved by the user on 2026-11-11 (evidence: docs/phases/phase-03-videos/spike-pgboss.md); recorded in the gates table above.
  - pg-boss 12 is ESM-only: added src/test/pg-boss-native.cjs + moduleNameMapper (and the cjs extension) in the integration Jest project (package.json). Not in the SI text; required for any Jest test to load pg-boss. SI-03.5 must add the same mapping to the unit project and test/jest-e2e.json.
  - Queue policy finding: singletonKey dedupes only with policy exclusive (not standard); SI-03.5 must create video.process with policy exclusive.
  - retryCount increments on re-claim, not on fail (attempt fence); recovery needs expireInSeconds elapsed + a supervise pass.
  - Out of scope: pg 8.23 deprecation warning from TypeORM clearDatabase (Promise.all on one client) in the existing src/test/prepare-test-database.ts global setup; becomes an error in pg@9.

### SI-03.2 — Infra: configuração e contrato de ambiente (storage, upload, worker, fila)
- **Status:** completed
- **Tests:** 17 passing (env.validation.spec.ts 15, phase-03.config.spec.ts 2); regression on Node 26: npm test 223 passing, test:e2e 52 passing, spike 10/10, tsc 0, eslint baseline
- **Observations:**
  - Runtime pinned to Node.js 26.13.1 LTS (Lithium) by tag + digest in Dockerfile.dev (user condition 1); container rebuilt; argon2 (native) and pg-boss (ESM) load.
  - Spike re-run on Node 26: 10/10 (user condition 2, verified before SI-03.5).
  - Defaults live once in src/config/video.constants.ts (used by Joi and the registerAs factories).
  - .env.example keeps the four credentials empty (AC: no credential value); local .env (git-ignored) received development placeholders so the required keys validate.
  - Existing fixture src/config/env.validation.integration-spec.ts updated with the new required credentials.
  - nestjs-api service in compose.yaml has no environment block (it reads .env); the MinIO and worker services get theirs in SI-03.3 / SI-03.12.

### SI-03.3 — Infra: imagem MinIO fixada e serviço Compose (Verification Gate 2)
- **Status:** completed
- **Tests:** no tests (Infra); 4 ACs verified by executed checks (docs/phases/phase-03-videos/gate-02-minio.md)
- **Observations:**
  - Gate 2 PASS with executed evidence; minisign (no public key in the repo) and ARM64 (amd64 host) kept as documented build args, not exercised.
  - Compose interpolation uses ${VAR:?} so MinIO refuses to start without MINIO_ROOT_USER / MINIO_ROOT_PASSWORD in .env.

### SI-03.4 — Módulo de storage S3 (dois endpoints, presigner, bucket)
- **Status:** completed
- **Tests:** 36 passing (unit 26: multipart-cleanup + classification, storage.module, test-storage; integration 10 against the pinned MinIO); regression npm test 259, test:e2e 52, tsc 0, eslint baseline
- **Observations:**
  - @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner 3.1167.0 installed (Context7 snapshot lists up to 3.1153.0; the surface used matches library-refs.md).
  - Verified on the pinned MinIO: the upload-binding object metadata set at CreateMultipartUpload survives CompleteMultipartUpload (residual risk noted in the plan revision is cleared for SI-03.10).
  - Three clients: internal (SDK retries), singleAttempt (maxAttempts 1, for Create/Complete) and publicSigner; every call bounded by connectionTimeout 3 s / requestTimeout 15 s plus an AbortSignal.
  - Test helper fetchPresigned connects to S3_ENDPOINT while keeping the public Host header the signature is bound to (the API container cannot reach localhost:9000).
  - listParts gained an optional pageSize (MaxParts) so pagination is testable without 1000+ parts.
  - Plan Tests row storage-key.spec.ts was replaced in the plan revision by multipart-cleanup.spec.ts; storage-key.ts is two one-line functions covered by the integration test keys.

### SI-03.5 — Módulo de fila pg-boss (API publica, worker consome)
- **Status:** completed
- **Tests:** 16 passing (unit 11: queue.module, test-queue; integration 5: job-publisher on real PostgreSQL); migrations suite updated (4 passing); spike 10/10 on Node 26; regression npm test 276, test:e2e 52, tsc 0, eslint baseline
- **Observations:**
  - User condition 3 met: video.process created with policy exclusive; dedupe by singletonKey verified on real PostgreSQL (queued and active), plus rollback publishes nothing.
  - Schema mechanism: hand-written migration 1794452175254-CreatePgBossSchema (skeleton from migration:create) applies getConstructionPlans(PGBOSS_SCHEMA) with the library BEGIN/COMMIT unwrapped so it joins the migration transaction (any TypeORM transaction mode); fails loudly if the plan format changes; idempotent (skips when the schema version table exists).
  - Test isolation: setup-test-env and prepare-test-database rewrite PGBOSS_SCHEMA to PGBOSS_TEST_SCHEMA (mirrors DB_NAME); the test queue schema is dropped before migrations on every run. The spike now uses its own schema pgboss_spike_test so its afterAll drop cannot affect other suites.
  - Existing src/database/migrations.integration-spec.ts adjusted: the last migration is now the pg-boss one (new revert test) and the auth-tokens revert/re-apply tests undo two migrations.
  - pg-boss Jest mapping extended to the unit project and test/jest-e2e.json (spike finding 1).
  - The dev database still needs migration:run before the API/worker boot with the QueueModule (SI-03.8 / SI-03.12).

### SI-03.6 — Entidade Video, migration e identificador público
- **Status:** completed
- **Tests:** 15 passing (unit 3: public-id.generator; integration 12: video.entity 9, public-id.generator 3); migrations suite updated (5 passing); regression npm test 292, test:e2e 52, tsc 0, eslint baseline
- **Observations:**
  - Migration 1794453245701-CreateVideos generated by migration:generate; contains only the videos objects (2 enums, table, CHECKs, UNIQUE public_id, unique (channel_id, idempotency_key), 5 indexes, FK ON DELETE RESTRICT).
  - Dev database (streamtube) has synchronize residue: users/channels/tokens tables exist with an empty migrations table, so migration:run fails on CreateUsersAndChannels. Not touched (the documented recovery drops dev tables = data loss; user condition 10). Needs a decision before the API/worker can boot against the dev DB (SI-03.12/SI-03.17); the test database is unaffected.
  - Relation kept unidirectional (Video -> Channel, ON DELETE RESTRICT) — deviation from the "define both sides" entity rule: an inverse Channel.videos would force Video into every Channel data source of other modules (13 test files) and break AppModule boot until VideosModule exists; no flow navigates channel -> videos.
  - upload_binding_token is select: false (token rule); flows that need it load it explicitly.
  - insertWithUniquePublicId uses the deprecated onConflict('("public_id") DO NOTHING') because orIgnore() cannot name the conflict target (it would swallow the idempotency unique violation).
  - media_metadata typed as MediaMetadata (TypeORM QueryDeepPartial rejects Record<string, unknown>).
  - cleanAllTables deletes videos before channels (FK); migrations suite reverts videos, then pg-boss, then auth tokens.

### SI-03.7 — Política de acesso e serviço de início de upload
- **Status:** completed
- **Tests:** 31 passing (unit 19: upload-admission, video-access.policy, video-upload.service; integration 12 on real PostgreSQL + MinIO); regression npm test and test:e2e green, tsc 0, eslint baseline
- **Observations:**
  - All 10 ACs covered, including concurrent owner starts (capacity for one: MAX_ACTIVE=1 and pending = one request), both 10 GiB requests admitted with defaults, lost CreateMultipartUpload response (orphan session aborted on retry, one session left), 3 concurrent retries (one creates, others 409 at once), storage down during investigation (reservation kept, nothing created), unlock not confirmed (connection discarded, next start locks).
  - Phase 2 lock uses a dedicated pg.Client (never pooled, always closed in finally) instead of a pooled TypeORM QueryRunner: TypeORM releasePostgresConnection is private, and closing the dedicated connection releases the session lock by construction. Added @types/pg (dev dependency, types only).
  - First multipart creation of a fresh reservation skips the key investigation: a session can only exist after an attempt, and every attempt writes multipart_create_attempted_at first.
  - Filename sanitizer filters control characters by char code (no eslint-disable; project rule).
  - Storage-failure branches are tested in integration with jest.spyOn on StorageService (compensation-logic rule); the unit spec covers the pre-database size check.

### SI-03.8 — Endpoints POST /videos e GET /videos/:id
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Endpoints de partes, retomada e cancelamento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Serviço de conclusão do upload (Verification Gates 4 e 5)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Endpoint POST /videos/:id/upload/complete
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Infra: entrypoint do worker e serviço Compose `worker`
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Probe de mídia, regra de formato e thumbnail (Verification Gate 6)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.14 — Worker de processamento do vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.15 — Reaper/reconciliador agendado
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.16 — URLs de reprodução e download (Verification Gates 7 e 8)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.17 — Verificação ponta a ponta de 10 GiB (Verification Gate 3)
- **Status:** pending
- **Tests:** —
- **Observations:** none
