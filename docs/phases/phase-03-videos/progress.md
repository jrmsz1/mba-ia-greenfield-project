# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 13/17 completed

## Required Technical Verification Gates

_Execution status of the 8 gates listed in context.md → Testing Requirements (that table is the planning snapshot and stays PENDING; editing it would invalidate validation.md). A gate is PASS only with executed evidence and human approval._

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | TypeORM + pg-boss transactional integration (TD-05) | PASS — approved 2026-11-11 | docs/phases/phase-03-videos/spike-pgboss.md; src/queue/pgboss-spike.integration-spec.ts |
| 2 | Pinned MinIO image, SHA-256, Compose, healthcheck, CORS (TD-03, TD-16) | PASS — evidence executed 2026-11-11 (minisign/ARM64 preserved as options, not exercised) | docs/phases/phase-03-videos/gate-02-minio.md |
| 3 | 10 GiB upload end to end (TD-01, TD-08, TD-13) | PENDING | — |
| 4 | Ambiguous completion: identity and integrity proof (TD-02) | EVIDENCE EXECUTED 2026-11-12 on the pinned MinIO — PASS proposed, awaiting human approval | docs/phases/phase-03-videos/gate-04-05-completion.md; src/videos/video-completion.service.integration-spec.ts |
| 5 | Concurrent completions (TD-02, TD-09) | EVIDENCE EXECUTED 2026-11-12 at service level (5 concurrent VideoCompletionService.complete calls; no concurrent HTTP scenario) — PASS proposed, awaiting human approval | docs/phases/phase-03-videos/gate-04-05-completion.md; src/videos/video-completion.service.integration-spec.ts |
| 6 | Real media fixtures (TD-07, TD-15) | EVIDENCE EXECUTED 2026-11-12 on the worker image FFmpeg 7.1.5 — PASS proposed, awaiting human approval | docs/phases/phase-03-videos/gate-06-media.md; src/media/media-probe.integration-spec.ts |
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
- **Status:** completed
- **Tests:** 10 E2E passing (test/videos-start-and-status.e2e-spec.ts, from nestjs-project/specs/videos-start-and-status.plan.md, 10/10 scenarios) + 4 unit (video-response.mapper, videos.module) + filter Retry-After unit; regression npm test 328, test:e2e 62, tsc 0, eslint baseline
- **Observations:**
  - All 6 ACs covered (201/200 replay, 400 VALIDATION_ERROR / UPLOAD_SIZE_EXCEEDED, owner 200 vs 404, 12 starts in < 1 min with no throttler 429, 401 without token).
  - Bug found by the E2E: @Headers(name, pipe) does not run pipes in NestJS, so the Idempotency-Key was never validated (500 on a missing header). Fixed with a custom @IdempotencyKey(IdempotencyKeyPipe) param decorator.
  - DomainExceptionFilter (common) now sets Retry-After when a domain exception carries retryAfterSeconds (needed by the 503/409 contracts); existing behavior unchanged, unit-tested.
  - Test isolation: setup-test-env also rewrites S3_BUCKET to S3_TEST_BUCKET (the StorageModule bucket bootstrap runs on every AppModule boot now).
  - Spec group 2 says StorageService overridden via overrideProvider; implemented with jest.spyOn on the app StorageService delegating to real MinIO (same fault injection, no extra module).
  - openapi.json regenerated (POST /videos, GET /videos/{id}).

### SI-03.9 — Endpoints de partes, retomada e cancelamento
- **Status:** completed
- **Tests:** 10 E2E passing + 1 todo (test/videos-upload-parts.e2e-spec.ts, from nestjs-project/specs/videos-upload-parts.plan.md) + 12 unit (video-upload-parts.service.spec.ts) + 2 integration on real MinIO; regression npm test 342, test:e2e 72 + 1 todo, tsc 0, eslint baseline
- **Observations:**
  - All 8 ACs covered. Spec scenario 2.3 (control window shared with POST complete) is an explicit it.todo until SI-03.11 creates the complete route; SI-03.11 implements it in the same e2e file.
  - Operations live in a new VideoUploadPartsService (plan said "add to VideoUploadService"; split for single responsibility, the plan Tests row already names video-upload-parts.service.*).
  - PostgreSQL-only limits: part_urls_issued reserved with one conditional UPDATE (cap 10 × parts); windowed-counter.ts implements the one-hour window (control now, delivery in SI-03.16).
  - Abort marks cancelled only when confirmUploadsGone returns aborted; a transient abort error or a ListParts that never confirms answers 503 and keeps the reservation.
  - E2E helper now listens on an ephemeral port: supertest opened one listener per request and 25 concurrent requests reset connections.
  - openapi.json regenerated (part-urls, upload status, abort).

### SI-03.10 — Serviço de conclusão do upload (Verification Gates 4 e 5)
- **Status:** completed
- **Tests:** 10 integration on pinned MinIO (video-completion.service.integration-spec.ts) + 6 integration (upload-recovery.service.integration-spec.ts) + 8 unit (completion-proof.spec.ts) + 6 unit (storage-errors.spec.ts); regression npm test 52 suites / 372, test:e2e 72 + 1 todo, tsc 0, eslint baseline
- **Observations:**
  - All 9 ACs verified with executed evidence; Gates 4 and 5 report in gate-04-05-completion.md.
  - Final multipart ETag on the pinned MinIO is deterministic for the verified manifest; FINAL_ETAG_IS_DETERMINISTIC = true is now evidence-backed (additional check only, never a checksum).
  - Fix in storage-errors.ts: the SDK re-throws a 200-with-<Error> as 503/server fault keeping the code, so InvalidPart was misclassified as ambiguous; definitive S3 codes are now matched before any status rule (new storage-errors.spec.ts).
  - Recovery logic shared with the reconciler lives in UploadRecoveryService (resolve with allowRelease only for the reconciler); VideoCompletionService only runs the protocol.
  - Fault injection is a real HTTP proxy (src/test/s3-fault-proxy.ts) in front of CompleteMultipartUpload only; the "storage unreachable" scenario uses a real client on a closed port.

### SI-03.11 — Endpoint POST /videos/:id/upload/complete
- **Status:** completed
- **Tests:** 10 E2E passing (test/videos-upload-complete.e2e-spec.ts, from nestjs-project/specs/videos-upload-complete.plan.md) + parts spec 2.3 now implemented (todo removed) + 8 unit (complete-upload.dto.spec.ts); regression npm test 53 suites / 380, test:e2e 6 suites / 83, tsc 0, eslint baseline
- **Observations:**
  - All 7 ACs covered; 202 carries Retry-After: 60 (COMPLETION_RETRY_AFTER_SECONDS) and reserveControlCall runs before any storage call (3.1 asserts no listParts/complete/headObject call).
  - Aligned the retried complete with TD-02 step 7: when the session is still open and no object exists, the claim is released and the protocol re-runs in the same call (SI-03.10 had restricted release to the reconciler, which made spec 3.3 unreachable). Safe on the pinned build: concurrent Completes give one success + NoSuchUpload, and only the proof moves the row.
  - Safety fix: the ListParts → NoSuchUpload path no longer feeds the unverified client manifest into the proof (a wrong manifest could have "contradicted" a valid object and deleted it); only the post-verification Complete path passes the manifest.
  - A terminal outcome of the completion (e.g. failed/UPLOAD_INVALID) now answers 409 INVALID_VIDEO_STATE, per the API contract, instead of 200.
  - Spec 2.3 "incomplete manifest": implemented as a full-length manifest for parts storage does not hold (409 UPLOAD_PARTS_MISMATCH); a shorter manifest would be 400 by the contract.
  - Fault injection in E2E: S3_CLIENTS overridden (createVideosApp option) so only Complete goes through the real fault proxy; proxy gained a sticky mode (failAllCompletes).
  - openapi.json regenerated (route with 200/202/400/401/404/409/429/503). Out of scope, noted as a separate task: openapi:export runs through ts-node without the Swagger CLI plugin, so EVERY request DTO schema is exported with empty properties (pre-existing since 2953d69, e.g. RegisterDto).

### SI-03.12 — Infra: entrypoint do worker e serviço Compose `worker`
- **Status:** completed
- **Tests:** 1 unit (worker.module.spec.ts, compile test); regression npm test 54 suites / 381, test:e2e 6 suites / 83, tsc 0, eslint baseline
- **Observations:**
  - Was blocked on AC #1: the dev DB had synchronize residue, an empty `migrations` table and no pg-boss schema. The user authorized a non-destructive baseline, executed with a verified backup and proven structural equivalence (docs/phases/phase-03-videos/dev-db-baseline.md); dev data preserved.
  - All 4 ACs verified on the dev DB: `docker compose up -d worker` running, `docker compose port worker` empty, uid 10001 `worker` (nologin); `docker compose stop worker` → exit 0 in 850 ms, 0 active jobs. Earlier isolated run on the test resources: same results (384 ms).
  - ffmpeg/ffprobe pinned to Debian 13 package 7:7.1.5-0+deb13u1 (`ffmpeg -version` / `ffprobe -version` → 7.1.5-0+deb13u1).
  - The worker mounts the code at /srv/app: /home/node is 0700 in the node base image, so a non-root user other than `node` cannot traverse it.
  - Shared roots extracted to src/app-roots.ts (ConfigModule + TypeORM) and used by AppModule and WorkerModule; no nest-cli.json change was needed — `nest build` (tsc) already emits dist/worker/main.worker.js, which `start:worker` and the image CMD run.

### SI-03.13 — Probe de mídia, regra de formato e thumbnail (Verification Gate 6)
- **Status:** completed
- **Tests:** worker container `npm run test:media` → 4 suites / 65 passed (23 integration on real FFmpeg 7.1.5 + media-rule/thumbnail-policy/redact unit); nestjs-api npm test 57 suites passed + 1 skipped (the media integration, by design) / 423 passed + 23 skipped; test:e2e 6 suites / 83; tsc 0; eslint baseline
- **Observations:**
  - All 6 ACs verified with executed evidence; Gate 6 report in gate-06-media.md (PASS proposed, awaiting human approval).
  - The real-media suite runs in the worker container: TD-06 keeps the API image free of FFmpeg, so Dockerfile.dev was NOT changed. Added `npm run test:media` (MEDIA_TOOLS_REQUIRED=1); nestjs-project/CLAUDE.md documents that a full regression now also includes it.
  - UNSUPPORTED_FORMAT vs DURATION_LIMIT_EXCEEDED kept distinct: the ceiling is evaluated only after the whole accepted-format rule passes (unit + real 6 s fixture with a 5 s ceiling).
  - A truncated MP4 with intact header passes ffprobe (as in TD-07 E3); recorded by a test, left to the TD-02 size check and thumbnail decode per TD-07. The AC's truncated fixture (moov lost) is rejected.
  - Brand allowlist: isom + iso2/mp41/mp42/avc1, each backed by a generated fixture (plan: "isom, completada pelas fixtures").
  - Fixtures are generated at test time into a temp dir (no committed binaries); `test/fixtures/media/out` is git-ignored for manual runs.
  - MediaModule (FfprobeRunner, FfmpegRunner) imported by WorkerModule; the processing handler that uses it is SI-03.14.

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
