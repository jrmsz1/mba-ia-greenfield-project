# phase-03-videos — Progress

**Status:** completed
**SIs:** 17/17 completed

## Required Technical Verification Gates

_Execution status of the 8 gates listed in context.md → Testing Requirements (that table is the planning snapshot and stays PENDING; editing it would invalidate validation.md). A gate is PASS only with executed evidence and human approval._

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | TypeORM + pg-boss transactional integration (TD-05) | PASS — approved 2026-11-11 | docs/phases/phase-03-videos/spike-pgboss.md; src/queue/pgboss-spike.integration-spec.ts |
| 2 | Pinned MinIO image, SHA-256, Compose, healthcheck, CORS (TD-03, TD-16) | PASS — evidence executed 2026-11-11 (minisign/ARM64 preserved as options, not exercised); formally approved by the user on 2026-11-13 (CP4 approval), covering this evidence and its re-validation under the least-privilege identities in CP2 (cp2-least-privilege-migration.md §5) | docs/phases/phase-03-videos/gate-02-minio.md; docs/phases/phase-03-videos/cp2-least-privilege-migration.md |
| 3 | 10 GiB upload end to end (TD-01, TD-08, TD-13) | PASS — approved by the user 2026-11-13 on commits `9821dfb` (script) and `c1d7416` (evidence): 16/16 criteria executed on a real file of exactly 10 737 418 240 B; limitations of the scale proof recorded under SI-03.17 | docs/phases/phase-03-videos/verification-10gib.md; scripts/verify-large-upload.ts |
| 4 | Ambiguous completion: identity and integrity proof (TD-02) | PASS — approved by the user 2026-11-12 on commit `b9a31844b054649b43a733625ef64ff29d1f53b8` (evidence: 59 tests on the real PostgreSQL + pinned MinIO, command `docker compose exec -T nestjs-api npx jest --selectProjects unit integration --testPathPatterns 'completion-proof|video-completion|upload-recovery|video-reconciler' --verbose`; regression npm test 470 + 32 skipped, test:e2e 84, worker test:media 110) | docs/phases/phase-03-videos/gate-04-05-completion.md; src/videos/video-completion.service.integration-spec.ts; src/videos/upload-recovery.service.integration-spec.ts; src/worker/video-reconciler.worker.integration-spec.ts |
| 5 | Concurrent completions (TD-02, TD-09) | PASS — approved by the user 2026-11-12 (evidence: 5 concurrent service-level completions → one `uploaded`, one job; command `npx jest --selectProjects integration --testPathPatterns video-completion`) | docs/phases/phase-03-videos/gate-04-05-completion.md; src/videos/video-completion.service.integration-spec.ts |
| 6 | Real media fixtures (TD-07, TD-15) | PASS — approved by the user 2026-11-12 (evidence: `docker compose run --rm --no-deps worker npm run test:media` → 65 passed, 23 integration on real FFmpeg 7.1.5) | docs/phases/phase-03-videos/gate-06-media.md; src/media/media-probe.integration-spec.ts |
| 7 | Presigned URL expiry and renewal (TD-11) | PASS — approved by the user 2026-11-12 on commit `a0da9d6` (evidence: real pinned MinIO, TTL override 2 s test-only: 206 → 403 after expires_at → renewed URL 206 at the same byte; `npx jest --selectProjects integration --testPathPatterns video-delivery` + E2E 1.3) | docs/phases/phase-03-videos/gate-07-08-delivery.md; src/videos/video-delivery.storage.integration-spec.ts; test/videos-delivery-urls.e2e-spec.ts |
| 8 | HTTP Range directly on MinIO (TD-11) | PASS — approved by the user 2026-11-12 on commit `a0da9d6` (evidence: URLs emitted by the API on the real Compose MinIO: 206 + Content-Range/Content-Length/Accept-Ranges with exact bytes, 416, 403 unsigned/tampered; storage suite + E2E 1.2) | docs/phases/phase-03-videos/gate-07-08-delivery.md; src/videos/video-delivery.storage.integration-spec.ts; test/videos-delivery-urls.e2e-spec.ts |

**Least-privilege revisions — executed 2026-11-12 (evidence: docs/phases/phase-03-videos/cp2-least-privilege-migration.md):** the pending "Revisão 2026-11-12" blocks of SI-03.2, SI-03.3, SI-03.4, SI-03.12 and SI-03.16 are implemented (commits 86320e7, bd3bb39, 5f210e2, a699579, 069fe40, 58e0899, a0dea07) and applied to the main environment after a rehearsed recovery (roll-forward and restore, isolated replica). Main environment: 7 identities + 7 policies provisioned (idempotent), only `nestjs-api`/`worker` recreated, the 47 abandoned sessions, the buckets, the databases and the dump preserved. Executed: `verify.sh` 13/13, `verify.sh --full` 15/15 (npm test 596 + 32 skipped FFmpeg suites run in test-worker, e2e 92, test:media 113, tsc, eslint). Gates 2, 4, 5, 6, 7, 8 and the reconciler suite re-run under the new identities (122 + 30 + 32 tests, 0 failed) — re-validation approved by the user with CP2 (2026-11-12); the approvals above are unchanged. **CP4 closing (2026-11-12):** `verify.sh --full` RESULT: PASS (npm test 596 passed + 32 skipped FFmpeg suites, e2e 92/92, test:media 113/113, tsc 0, eslint 0 errors / 1 known warning), `npm run lint` exit 0 with no file changed, migrations 4/4 applied, Compose valid; audit in docs/phases/phase-03-videos/mba-audit.md. **CP5 evaluator simulation (2026-11-13):** clean clone in an isolated Compose project (docs/phases/phase-03-videos/evaluator-simulation.md) — found and fixed a build defect (`f809631`: the Gate 3 script inside the production build broke `dist/main` on a fresh build); after it, `setup.sh` complete in 102 s, `verify.sh` 13/13, video flow 12/12 (twice), `npm test` 596 / e2e 92 / media 113 / tsc / eslint on the clone; one intermittent AuthService integration failure (4 tests) not reproduced twice, cause indeterminate; main environment unchanged except the shared provisioning image tag.

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
  - All 6 ACs verified with executed evidence; Gate 6 report in gate-06-media.md (PASS proposed, awaiting human approval — later approved by the user on 2026-11-12, see the gates table).
  - The real-media suite runs in the worker container: TD-06 keeps the API image free of FFmpeg, so Dockerfile.dev was NOT changed. Added `npm run test:media` (MEDIA_TOOLS_REQUIRED=1); nestjs-project/CLAUDE.md documents that a full regression now also includes it.
  - UNSUPPORTED_FORMAT vs DURATION_LIMIT_EXCEEDED kept distinct: the ceiling is evaluated only after the whole accepted-format rule passes (unit + real 6 s fixture with a 5 s ceiling).
  - A truncated MP4 with intact header passes ffprobe (as in TD-07 E3); recorded by a test, left to the TD-02 size check and thumbnail decode per TD-07. The AC's truncated fixture (moov lost) is rejected.
  - Brand allowlist: isom + iso2/mp41/mp42/avc1, each backed by a generated fixture (plan: "isom, completada pelas fixtures").
  - Fixtures are generated at test time into a temp dir (no committed binaries); `test/fixtures/media/out` is git-ignored for manual runs.
  - MediaModule (FfprobeRunner, FfmpegRunner) imported by WorkerModule; the processing handler that uses it is SI-03.14.

### SI-03.14 — Worker de processamento do vídeo
- **Status:** completed
- **Tests:** 10 unit (video-processing.worker.spec.ts) + 8 integration on real pg-boss/PostgreSQL/pinned MinIO/FFmpeg 7.1.5 (video-processing.worker.integration-spec.ts, worker container); regression: nestjs-api npm test 58 passed + 2 skipped suites (437 passed + 31 skipped — the FFmpeg suites), test:e2e 6 suites / 84, worker `npm run test:media` 7 suites / 83; tsc 0; eslint baseline
- **Observations:**
  - All 8 ACs verified: ready with duration/metadata/thumbnail_generated_at + `videos/<id>/thumbnail.jpg`; HEVC → failed/UNSUPPORTED_FORMAT after 1 attempt (retryCount 0); transient then success → ready with processing_attempts = 2 and a different input URL per attempt; duplicate delivery → no second thumbnail write, single ready; job data = `{ videoId }` only; missing original → probe never runs, failed/PROCESSING_FAILED; no X-Amz/URL in worker logs, job output or failure_reason; 0 `idle in transaction` sessions while the probe runs.
  - Attempt fence (user requirement): the claim increments processing_attempts and every conclusion (`ready`/`failed`) is `WHERE processing_status = 'processing' AND processing_attempts = <own attempt>`; a stale worker whose attempt was re-claimed ends `superseded` and cannot conclude (integration test).
  - Exhausted retries → failed/PROCESSING_FAILED decided in the handler from job.retryCount ≥ retryLimit (the job then completes); transient errors are rethrown with a redacted message because pg-boss persists it in the job output.
  - A thumbnail decode failure (permanent ffmpeg error) → failed/PROCESSING_FAILED (TD-07: covers files that pass ffprobe but are incomplete).
  - pg-boss typing: `work(name, { includeMetadata: true }, ([job]: JobWithMetadata<…>[]) => …)` without an explicit generic — passing `<T>` disables inference of the literal options and selects the metadata-less handler.
  - Separate task (out of scope, pre-existing since SI-03.12): a SIGTERM that arrives while the worker is still booting (before enableShutdownHooks) is ignored by Node as PID 1 and Docker SIGKILLs after stop_grace_period (exit 137, reproduced). After boot the stop is graceful (exit 0, <1 s). Safe by design (pg-boss expiry + attempt fence); candidate fix: `init: true` on the worker service or installing the signal handler before bootstrap.

### SI-03.15 — Reaper/reconciliador agendado
- **Status:** completed
- **Tests:** 10 unit (video-reconciler.worker.spec.ts) + 10 integration on real PostgreSQL/pinned MinIO/pg-boss (video-reconciler.worker.integration-spec.ts) + 2 integration on the real entrypoint (main.worker.integration-spec.ts); regression: nestjs-api npm test 61 passed + 2 skipped suites (461 passed + 32 skipped — the FFmpeg suites), test:e2e 6 suites / 84, worker `npm run test:media` 10 suites / 107; tsc 0; eslint baseline
- **Observations:**
  - All 8 ACs verified: expired upload → expired + ListParts NoSuchUpload; abort repeated when the first abort does not end the session; expired-but-completed object → proof → uploaded + job (never expired); orphan reservation removed only after NoSuchUpload + HeadObject 404; storage unreachable → orphan, expired and stale rows unchanged (quota kept); stale completing with a proven object → uploaded + 1 job; uploaded without job → exactly one job, second run none; two overlapping runs → each transition and job exactly once.
  - Review requirements: the reconciler never calls DeleteObject; an object with a divergent binding is preserved (row stays uploading, quota kept, `indeterminate`); capacity is released only on `aborted`; StorageError is never read as absence; every per-video action runs under the SAME non-blocking session lock as the upload start + compare-and-set.
  - The SI-03.7 advisory lock was extracted to src/videos/video-session-lock.ts (`withVideoSessionLock`, same SQL, same dedicated connection) and is shared by VideoUploadService and the reconciler; behavior unchanged (upload suites green).
  - Review item 1: the processing worker now checks the original's upload-binding in addition to its size (foreign/missing → UPLOAD_INVALID, no probe, no delete).
  - Review item 2: the thumbnail PUT + `ready` run in one short transaction that row-locks the video only if it still belongs to the attempt; a stale attempt never writes the thumbnail (unit + integration). The lock is held only for the JPEG PUT, never during the media tools.
  - Review item 3 (boot shutdown): reproduced exit 137 after 41 s on a stop during boot; fixed with `init: true` (tini) on the worker service + an early signal handler, and job consumption now starts only after enableShutdownHooks. After: stop during boot and after boot both ~1 s, exit 143 (SIGTERM), "pg-boss stopped gracefully (SIGTERM)" logged. Reproducible test: main.worker.integration-spec.ts spawns the real entrypoint.
  - Review item 4: the pinned MinIO ignores If-Match on DeleteObject (verified); `markInvalid` re-reads HeadObject immediately before deleting and keeps a changed object. A residual window remains (documented in gate-04-05-completion.md).
  - Documentary pending item (Gate 4): no conflict with TD-02 (it prescribes deletion only for a size mismatch); the plan Error Catalog row UPLOAD_INVALID is out of sync and needs `/decide` (Append revision to TD-02) + an append-mode plan sync. Resolved on 2026-11-12: TD-02/TD-09 revisions recorded and the plan's Error Catalog row UPLOAD_INVALID synced.
  - Residual verification (2026-11-12, after Gate 4 approval): with a multipart session still OPEN and a missing/foreign-binding object at the key, the reconciler moved the row to failed/UPLOAD_INVALID and released the quota reservation prematurely (reproduced on real PostgreSQL + MinIO: 3 failing tests). Fixed in UploadRecoveryService.markInvalid: no UPLOAD_INVALID transition until the known upload id answers NoSuchUpload AND the key session listing is empty; a storage error defers. Tests: video-reconciler.worker.integration-spec.ts (expired uploading x2, stale completing). Object still never deleted.
  - Known limitation (liveness, non-blocking, accepted 2026-11-12): a video in completing + an open multipart session + an object with a divergent/missing binding at the key stays completing until manual intervention (the reconciler counts it indeterminate each run and keeps the quota). Fail-closed by design: no destructive cleanup and no quota release without positive proof.
  - Entrypoint shutdown test (main.worker.integration-spec.ts) stabilized 2026-11-12. Two proven races, both in the TEST, not in main.worker.ts: (1) polling the output every 100 ms let a fast boot finish before SIGTERM under full-suite load (code/signal mismatch); (2) the exit listener was attached only after the output wait, so a child that exited inside that gap was never observed (120 s timeout, captured in a full worker run; a late `exit` listener is provably never called). Fix: exit listener attached at spawn; SIGTERM sent from the output event on the accumulated output. Evidence: 20/20 repetitions of the file and 5/5 full worker suites (113/113 each).

### SI-03.16 — URLs de reprodução e download (Verification Gates 7 e 8)
- **Status:** completed
- **Tests:** 10 unit (video-delivery.service.spec.ts) + 9 integration on the real pinned MinIO (video-delivery.storage.integration-spec.ts) + 8 E2E (test/videos-delivery-urls.e2e-spec.ts, spec videos-delivery-urls.plan.md + negatives); regression: nestjs-api npm test 63 passed + 2 skipped suites (492 passed + 32 skipped — the FFmpeg suites), test:e2e 7 suites / 92, worker `npm run test:media` 10 suites / 113; tsc 0; eslint baseline (implementation a0da9d6; AC #1 revision and credential checks in the closing commit)
- **Observations:**
  - AC #1 revised by human decision 2026-11-12 (option a): no secret key, admin token or other permanent secret in the response; S3_ACCESS_KEY_ID only inside X-Amz-Credential (AWS SigV4). Compatible with TD-04 (the client only ever receives presigned URLs) and TD-11 (no permanent credentials) — no TD change. Tested on both routes: exactly {url, expires_at}, no secret, no MinIO root password, no bearer token, no X-Amz-Security-Token, key ID only in X-Amz-Credential.
  - Risk recorded (not changed, needs authorization): locally the signing credential IS the MinIO root user (S3_ACCESS_KEY_ID = MINIO_ROOT_USER, secret = root password), so every emitted URL reveals the root identity and the API holds admin privileges. Least-privilege alternative: a dedicated MinIO user with a read-only GetObject policy on the bucket for the public signer, and a separate bucket-scoped user for the API/worker internal operations (a TD-04/TD-16 revision).
  - ACs #2–#6 verified with executed evidence: Range 206 + Content-Range (Gate 8), 416, 403 unsigned/tampered; expiry 403 after expires_at and renewal resuming at the same byte (Gate 7); Content-Disposition attachment RFC 6266; 409 VIDEO_NOT_READY / 404 VIDEO_NOT_FOUND; 61st URL → 429, then 200 after the window.
  - TTL per kind: X-Amz-Expires 3600 (playback) / 900 (download); the expiry tests use a test-only override of 2 s.
  - The delivery slot is reserved atomically before signing (shared 60/hour window); the URL is never logged or persisted — every E2E asserts no X-Amz-/Signature= in captured logs.
  - E2E stores random bytes instead of a media fixture (delivery never inspects content; the API container has no FFmpeg, TD-06).
  - openapi.json regenerated (both routes: 200/401/404/409/429).

### SI-03.17 — Verificação ponta a ponta de 10 GiB (Verification Gate 3)
- **Status:** completed (Gate 3 PASS approved by the user 2026-11-13; commits 9821dfb, c1d7416; evidence docs/phases/phase-03-videos/verification-10gib.md)
- **Tests:** on-demand verification `npm run verify:large-upload` in the ephemeral test-worker container (outside every Jest project): 16/16 checks PASS; independent full-object SHA-256 check; regression after the run `verify.sh --full` 15/15 (npm test 596 + 32 skipped FFmpeg suites run in test-worker, test:e2e 92, test:media 113, tsc, eslint)
- **Observations:**
  - File: exactly 10 737 418 240 B, valid MP4/H.264 yuv420p + AAC (3600 s), SHA-256 51cb136c…617885; generation command recorded and reproduced byte-identically.
  - Upload: 160 × 64 MiB parts PUT directly to MinIO with just-in-time presigned URLs; interrupted after 80 parts (3 in-flight aborted), resumed with exactly the 80 missing parts; quota refusal at the pending-bytes limit; API RSS 175–196 MiB (variation 21 MiB).
  - Completion proof (key, upload_id, exact size, upload-binding, session closed); one video.process job only after completion; worker ready in 5 s reading 21.9 MiB by Range (0.21 %); duration 3600 s, metadata, thumbnail; Range 206 at start and end of the object byte-identical; download attachment.
  - Kept, not deleted: the 10 GiB object + thumbnail in the test bucket and the streamtube-gate3-media volume (10 GiB); host disk −20.4 GiB. Main environment, the 47 historical sessions and the later ones preserved.
  - Limitations of the scale proof (recorded on approval): the file is a synthetic but valid MP4 (generated test pattern + noise + sine, H.264/AAC) padded to the exact size with a top-level `free` box; the transfer ran container → MinIO inside the Docker environment, so it does not represent real Internet conditions; API/worker memory was observed by sampling once per second; the run does not prove intensive transcoding of 10 GiB of audiovisual content (the phase performs no transcoding — only probe, metadata and one thumbnail, read by HTTP Range).
