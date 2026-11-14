# CLAUDE.md

## Environment Startup Verification

**First run on a machine:** `../scripts/setup.sh` (or `..\scripts\setup.ps1`) from the repository root. It generates the per-service credential files in `../.local/secrets/`, provisions MinIO, installs, builds, migrates and starts the whole stack (phase-03-videos/TD-15, TD-16). Re-running it is safe.

**Default behavior for the agent:** starting the environment means starting **only infrastructure services** — `docker compose up -d db mailpit minio` — **never** the API or the worker unless the user explicitly asks to run the project. (`docker compose up -d` without service names now starts the compiled API and the worker too.)

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO (object storage):** `docker compose exec minio curl -fsS http://localhost:9000/minio/health/ready` — expect exit code 0 (the service also reports `healthy` in `docker compose ps`).

`compose.yaml` requires the generated files `../.local/secrets/{minio,api,worker}.env`: without them Compose refuses to start (run the setup script). **Never run a plain `docker compose config`** — it prints the `env_file` values; use `docker compose config --quiet` or `--no-env-resolution`.

## Development Environment

This project runs inside Docker. Always use the containers for development:

```bash
../scripts/setup.sh                          # first time (and whenever in doubt): idempotent
docker compose up -d                         # API (compiled, npm run start:prod) + worker + infrastructure

# Hot reload instead of the compiled API (the dev server needs port 3000):
docker compose stop nestjs-api
docker compose run --rm --service-ports nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`; runs `npm run start:prod` (the setup builds `dist/`)
- `worker` — video worker (FFmpeg), no published ports; runs `dist/worker/main.worker.js`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `minio` — pinned MinIO built from `docker/minio/Dockerfile` (SHA-256-verified release binary), API port `9000`, console port `9001`, data in the `minio-data` volume
- `test-api`, `test-worker` (`compose.test.yaml`, profile `test`) — **ephemeral** test containers, only via `run --rm`

Credentials (phase-03-videos/TD-16): one `env_file` per service under `../.local/secrets/` — `minio.env` (root, `minio` only), `api.env` (API + read-only delivery identity), `worker.env` (worker identity), `test-api.env`/`test-worker.env` (restricted test identities, test containers only), `provision.env` (provisioning container), `maintenance.env` (maintenance container). The bind-mounted `.env` holds **no** credential; the API and the worker refuse to start if `MINIO_ROOT_*` or `S3_TEST_MAINTENANCE_*` reach them, and the tests refuse root, production and maintenance credentials. Never copy a credential into `.env`, a fixture, a log or a commit. The JWT signing secrets are the exception that lives in the git-ignored `.env`: the setup generates them (32 random bytes each, replacing missing, public, weak or identical values and keeping valid ones), and the API refuses to start with a missing or placeholder secret, one shorter than 32 characters or with fewer than 8 distinct characters, or the same value for access and refresh (`src/config/env.validation.ts`).

Host ports can be moved with `STREAMTUBE_API_PORT`, `STREAMTUBE_DB_PORT`, `STREAMTUBE_MINIO_PORT`, `STREAMTUBE_MINIO_CONSOLE_PORT`, `STREAMTUBE_MAILPIT_SMTP_PORT`, `STREAMTUBE_MAILPIT_UI_PORT` (defaults: the ports above). A second copy on the same machine also needs its own `COMPOSE_PROJECT_NAME`: otherwise Compose derives the project from the folder name (`nestjs-project`) and the copy would reuse the first copy's containers and volumes.

All verification and teardown commands run on the **host machine**:

```bash
../scripts/verify.sh                         # health, credential isolation, essential suites
curl http://localhost:3000                   # expect 200 + "Hello World!"
docker compose exec db pg_isready -U streamtube
docker compose logs nestjs-api
docker compose logs worker
docker compose down                          # keeps the data volumes
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands

Build, type-check, lint and **unit** tests run in the API container (`docker compose exec nestjs-api …`). **Integration, e2e and media suites run only in the ephemeral test containers** (phase-03-videos/TD-15): the operational `nestjs-api`/`worker` hold no test identity, so those suites refuse to start there by design.

```bash
# in nestjs-api (docker compose exec nestjs-api …)
npm run build                            # Compile to dist/
npm run test:unit                        # Unit tests only (no database, no storage)
npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix (modifies files)
npx eslint "{src,apps,libs,test}/**/*.ts" # ESLint check only (no --fix)
npm run format                           # Prettier formatting

# in the ephemeral test containers (T="docker compose -f compose.yaml -f compose.test.yaml run --rm")
$T test-api npm test                     # Unit + integration tests
$T test-api npm run test:integration     # Integration tests only (test database)
$T test-api npm run test:e2e             # End-to-end tests (test database)
$T test-api npm run test:cov             # Coverage report (unit + integration)
$T test-api npm run test:db:prepare      # Create/reset/migrate the test database without running tests
$T test-worker npm run test:media        # FFmpeg/ffprobe suites (worker image)
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test database

Integration and e2e tests run **only** against the dedicated test database named by `DB_TEST_NAME` (e.g. `streamtube_test`), never against the development database (`DB_NAME=streamtube`). See `README.md` → "Run tests" for the full setup.

- Both `DB_TEST_NAME` (must match `^[a-z][a-z0-9_]*_test$`) and `DB_TEST_SERVER_ID` (the server's `system_identifier`) must be set in the local `.env`. The setup script fills `DB_TEST_SERVER_ID` when it is empty. Without them, integration and e2e runs refuse to start. Get the identifier with `docker compose exec db psql -U streamtube -d streamtube -tAc "SELECT system_identifier FROM pg_control_system()"`.
- The **real value** of `DB_TEST_SERVER_ID` is machine-specific. It must never be included in `.env.example`, test fixtures or any commit; it lives only in the local, git-ignored `.env`. `.env.example` must keep documenting the variable **name with an empty value** (`DB_TEST_SERVER_ID=`). Fixtures use a fictitious identifier.
- Configuring these variables is a one-time step per developer. The test schema is not persistent: it is recreated on every run (see below).
- Keep `DB_NAME` pointing at the development database. `readTestDatabaseConfig()` rejects an original `DB_NAME` equal to `DB_TEST_NAME` (or any other `*_test` name) before any connection. `applyTestDatabaseEnv()` keeps the original value in module-private state (not in any environment variable, so it cannot be forged) before rewriting `DB_NAME`. Repeated calls therefore stay idempotent and never treat the rewritten value as the developer's.
- Every connection is verified (`current_database()` + `system_identifier`) before any schema change. Do not add fallbacks to `DB_NAME`, and do not bypass the guards in `src/test/test-database.ts`.
- **Destructive by design:** every integration/e2e run (via Jest `globalSetup`) and `npm run test:db:prepare` drop all tables, ENUM types and migration history of `DB_TEST_NAME`, then re-apply all migrations. The migrations suite also empties the schema before each test. Never point `DB_TEST_NAME` at data you want to keep.
- New database-backed test files must use the helpers in `src/test/create-test-data-source.ts` (`createTestDataSource`, `createTestTypeOrmModule`, `cleanAllTables`, `resetTestSchema`), which enforce the guard.
- New migrations must be added to `TEST_MIGRATIONS` in `src/test/test-migrations.ts`; the run fails fast if the list is out of sync with `src/database/migrations/`.

### Test execution

Integration and e2e suites share a single test database, so they **must** run serially. Both Jest configs enforce it with `"maxWorkers": 1` (`package.json` → `jest`, and `test/jest-e2e.json`), so the npm scripts are already serialized. They run in the ephemeral test containers, which receive only the restricted test identities (`S3_TEST_API_*`, `S3_TEST_WORKER_*`, `S3_TEST_DELIVERY_*`) and use only `DB_TEST_NAME`, `S3_TEST_BUCKET` and `PGBOSS_TEST_SCHEMA`:

```bash
docker compose -f compose.yaml -f compose.test.yaml run --rm test-api npm test
docker compose -f compose.yaml -f compose.test.yaml run --rm test-api npm run test:e2e
```

**Never pass `-w` / `--maxWorkers`** to a run that includes integration or e2e tests. The CLI flag overrides the config, and the guards cannot detect it. Parallel execution causes hook timeouts, FK violations, deadlocks and cross-suite contamination, because suites truncate, seed or reset shared tables concurrently. A separate concurrent Jest process is rejected by an advisory lock on `DB_TEST_NAME`. That lock does not protect against parallel workers inside one run.

**Storage in tests:** suites never create, empty or reset a bucket. Each test isolates its objects under the keys of the videos it creates and asserts only those keys; the test bucket is created by provisioning. Cleanup is the external maintenance container's (`../scripts/test-storage-maintenance.sh`, dry run unless `--confirm`), never automatic, never concurrent with a test run (it takes the same advisory lock).

**Media tests run in the worker image.** The API image is deliberately free of FFmpeg (phase-03-videos/TD-06), so the suites that need the real ffprobe/ffmpeg (`src/media/*.integration-spec.ts`, Verification Gate 6, and `src/worker/video-processing.worker.integration-spec.ts`) only run where the pinned FFmpeg is installed:

```bash
docker compose -f compose.yaml -f compose.test.yaml run --rm test-worker npm run test:media
```

In `test-api` the same suites are reported as **skipped**, not passed. `test:media` sets `MEDIA_TOOLS_REQUIRED=1`, so a missing ffprobe fails the run instead of skipping. It runs the `integration` project, so its globalSetup resets the test database like any integration run: never run it concurrently with `npm test` or `npm run test:e2e`. A full regression is `../scripts/verify.sh --full` (`npm test` + `npm run test:e2e` in `test-api`, `npm run test:media` in `test-worker`, `tsc`, eslint). A failing suite keeps its complete output in `../.local/verify-logs/` (git-ignored), redacted: local credential values, presigned-URL signature parameters and bearer tokens are masked.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). `--selectProjects` takes several values, so pass paths through `--testPathPatterns` when combining them (`npx jest --selectProjects integration --testPathPatterns src/auth`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

### Lint status

The lint baseline is clean. The original 149 errors (found while repairing the backend test baseline) were fixed in dedicated commits, and `npx eslint "{src,apps,libs,test}/**/*.ts"` now reports **0 errors and 1 known warning**: `@typescript-eslint/no-unsafe-argument` in `src/auth/auth.service.integration-spec.ts`. `npm run lint` passes with exit code 0. A change must not add lint problems, and rules must not be disabled to make code pass.

`npm run lint` runs ESLint with `--fix` and rewrites files. To check without changing anything, run `npx eslint "{src,apps,libs,test}/**/*.ts"` directly.

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config", ...]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `projects` in `package.json` split the suffixes: `unit` (`testRegex: '.*\\.spec\\.ts$'`, setup file `src/test/setup-unit-env.ts` blocks DB access) and `integration` (`testRegex: '.*\\.integration-spec\\.ts$'`, `globalSetup`/`globalTeardown` prepare and lock the test database, setup file `src/test/setup-test-env.ts` points `DB_NAME` at `DB_TEST_NAME`). `test/jest-e2e.json` uses the same globalSetup/globalTeardown and setup file.
- `maxWorkers: 1` at the **root** of both configs. Jest ignores `maxWorkers` inside a `projects` entry, so it cannot be scoped to the integration project.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos (Phase 03)

Backend-only phase: draft video, direct multipart upload to object storage, asynchronous processing and delivery URLs. Plan: `docs/phases/phase-03-videos/phase-03-videos.md` (Data Model, API Contracts, Authorization Matrix, Error Catalog, Events/Messages); decisions: `docs/decisions/technical-decisions-phase-03-videos.md` (TD-01…TD-16). Every video has a `title`, set at upload start (`src/videos/video-title.ts`). Editing it, a description and publishing come in Phase 04: Phase 03 only writes `publication = draft`, and there is no endpoint for the thumbnail.

### Modules

| Directory | Responsibility |
|---|---|
| `src/videos/` | `VideosModule`: `VideosController`, the `Video` entity (`videos` table, migrations `src/database/migrations/1794453245701-CreateVideos.ts` and `1794622489462-AddVideoTitle.ts`), the title rule (`video-title.ts`), upload start (`video-upload.service.ts`), part URLs / status / abort (`video-upload-parts.service.ts`), completion (`video-completion.service.ts`, `upload-recovery.service.ts`, `completion-proof.ts`), delivery URLs (`video-delivery.service.ts`), the ownership policy (`video-access.policy.ts`), the public id (`public-id.generator.ts`), abuse limits (`abuse-limits.ts`, `upload-admission.ts`) |
| `src/storage/` | `StorageModule`: the S3 clients (`s3-clients.provider.ts`, AWS SDK v3), `StorageService` (multipart, presigning, object checks), object keys (`storage-key.ts`), bucket verification at startup |
| `src/queue/` | `QueueModule`: pg-boss on the same PostgreSQL (schema `PGBOSS_SCHEMA`, default `pgboss`; created by migration `1794452175254-CreatePgBossSchema.ts`), queue creation, `JobPublisherService`, the TypeORM transaction adapter (`typeorm-pgboss-db.adapter.ts`) |
| `src/media/` | `MediaModule`: `FfprobeRunner` and `FfmpegRunner` (system binaries via `spawn`, bounded time and output), the accepted-format rule (`media-rule.ts`), thumbnail position (`thumbnail-policy.ts`) |
| `src/worker/` | Second entrypoint (`main.worker.ts`, compiled to `dist/worker/main.worker.js`, Compose service `worker`): `VideoProcessingWorker` and `VideoReconcilerWorker` |

### Endpoints (`src/videos/videos.controller.ts`)

| Method and path | Purpose | Success |
|---|---|---|
| `POST /videos` | Start an upload: creates the draft row and the S3 multipart session. Header `Idempotency-Key` required; body `filename`, `size_bytes`, optional `content_type` and `title`. Returns `id`, `title`, `upload_id`, `part_size_bytes`, `expected_part_count`, `upload_expires_at`. | 201 (200 on an idempotent replay) |
| `GET /videos/:id` | Status of the owner's video (`title`, `processing_status`, `failure_reason`, `duration_seconds`, `media_metadata`, `has_thumbnail`, …) | 200 |
| `POST /videos/:id/upload/part-urls` | Presigned `UploadPart` URLs for 1–100 `part_numbers` | 200 |
| `GET /videos/:id/upload` | Resume information: parts already in storage (number, size, ETag) and missing part numbers | 200 |
| `POST /videos/:id/upload/complete` | Completes the upload from the ordered manifest (`parts`: `part_number`, `etag`) and enqueues processing | 200; 202 + `Retry-After` while the outcome is not proven |
| `GET /videos/:id/playback-url` | Presigned streaming URL (`ready` only) | 200 |
| `GET /videos/:id/download-url` | Presigned download URL (`ready` only) | 200 |
| `DELETE /videos/:id/upload` | Cancels an incomplete upload | 204 |

`:id` is the public id. Error codes and statuses: plan §Error Catalog and the `@ApiResponse` declarations in the controller (OpenAPI with `SWAGGER_ENABLED=true`).

### Authentication and authorization (TD-12, TD-13)

- Every route requires the access token (global `JwtAuthGuard`); none is public. `POST /videos` needs the user's channel (`403 CHANNEL_REQUIRED`).
- One ownership rule, `VideoAccessPolicy.findOwnedVideoOrThrow`: the video must belong to the caller's channel. Malformed ids, unknown ids and other users' videos all answer `404 VIDEO_NOT_FOUND`.
- The controller is outside the authentication throttler (`@SkipThrottle()`); abuse limits are counted in PostgreSQL instead (`abuse-limits.ts`): 20 upload starts per hour per owner, part URLs up to 10 × `expected_part_count` per upload, 120 status + complete calls per video per hour, 60 playback + download URLs per video per hour, plus `MAX_ACTIVE_UPLOADS_PER_OWNER` (3) and `MAX_PENDING_UPLOAD_BYTES_PER_OWNER` (20 GiB).

### Upload flow (TD-01, TD-02, TD-13)

1. `POST /videos` validates `size_bytes` against `MAX_UPLOAD_BYTES` (default 10 737 418 240 = 10 GiB; larger → `400 UPLOAD_SIZE_EXCEEDED`), reserves quota, inserts the draft (`publication = draft`, `processing_status = uploading`, `title` = the client's title trimmed, or the file name without its extension) and calls `CreateMultipartUpload`.
2. The client asks for part URLs and sends each part (`UPLOAD_PART_SIZE_BYTES`, default 64 MiB, so 160 parts for 10 GiB) **directly to MinIO** with `PUT` on the presigned URL. The file never goes through the API.
3. An interrupted upload resumes with `GET /videos/:id/upload` (missing parts) and new part URLs, until `upload_expires_at` (`UPLOAD_EXPIRY_HOURS`, default 24).
4. `POST /videos/:id/upload/complete` checks the manifest against storage, completes the multipart upload, proves the final object (size, ETag, upload binding) and then, in **one** PostgreSQL transaction, moves the row to `uploaded` and enqueues `video.process`.

Presigned URLs are signed with SigV4 for `S3_PUBLIC_ENDPOINT` (the host-reachable MinIO). They expire after `UPLOAD_PART_PRESIGN_TTL_SECONDS` (900), `PLAYBACK_PRESIGN_TTL_SECONDS` (3600), `DOWNLOAD_PRESIGN_TTL_SECONDS` (900) and, for the worker's input, `PROCESSING_INPUT_PRESIGN_TTL_SECONDS` (3600). Responses carrying URLs are `Cache-Control: no-store`.

### Status lifecycle (TD-09)

Two independent columns:

- `publication` (enum `video_publication`): only `draft` in Phase 03.
- `processing_status` (enum `video_processing_status`):

```
uploading ─► completing ─► uploaded ─► processing ─► ready
   │              │             │            └─────► failed
   │              ├─► uploading (claim released)
   │              └─► failed (UPLOAD_LOST, UPLOAD_INVALID) / expired
   ├─► cancelled  (DELETE /videos/:id/upload)
   └─► expired    (reconciler, after upload_expires_at)
```

| Transition | Where |
|---|---|
| → `uploading` | `VideoUploadService.start` |
| `uploading → completing` | `VideoCompletionService` (completion claim) |
| `completing → uploaded` (+ job) | `UploadRecoveryService.markUploaded` |
| `completing → uploading / failed / expired` | `UploadRecoveryService.resolve` (also from `uploading`) |
| `uploading → cancelled` | `VideoUploadPartsService.abort` |
| `uploading → expired` | `VideoReconcilerWorker` |
| `uploaded → processing → ready / failed` | `VideoProcessingWorker` |

`failure_reason` values: `UPLOAD_LOST`, `UPLOAD_INVALID`, `UNSUPPORTED_FORMAT`, `DURATION_LIMIT_EXCEEDED`, `PROCESSING_FAILED` (`src/videos/video.constants.ts`). Every transition is a conditional `UPDATE … WHERE processing_status = <expected>`, so a duplicate or late delivery changes nothing.

### Queue and worker (TD-05, TD-06, TD-14)

| Queue | Producer | Consumer |
|---|---|---|
| `video.process` | the API, inside the completion transaction (and the reconciler when an `uploaded` row has no job) | `VideoProcessingWorker` |
| `video.reconcile` | pg-boss schedule `*/5 * * * *` | `VideoReconcilerWorker` |

- **`video.process` delivery:** the payload is only `{ videoId }` (the internal UUID). The queue policy is `exclusive` with `singletonKey = videoId`, so there is at most one queued or active job per video.
- **Retries:** transient errors are retried up to 3 times (first delay 30 s, with backoff). After the last one the video becomes `failed` / `PROCESSING_FAILED`.
- **Concurrency and timeout:** `WORKER_CONCURRENCY` defaults to 1. `WORKER_JOB_TIMEOUT_SECONDS` (1800) is the job's pg-boss expiry.
- **The reconciler:** expires abandoned uploads, resolves stale `completing` claims (`COMPLETING_STALE_MINUTES`, 15) and republishes missing `video.process` jobs.
- **Process layout:** the worker is a separate process and container from the same codebase. Only its image has FFmpeg; the API image does not.

### Processing: ffprobe, ffmpeg, metadata, thumbnail (TD-07, TD-08)

Each attempt re-reads the row, mints a fresh presigned GET for the original and lets ffprobe/ffmpeg read it over HTTP Range (no full copy to disk):

1. **ffprobe** reads the format and streams. Accepted: an MP4 container (major brand `isom`, `iso2`, `mp41`, `mp42` or `avc1`) with H.264 `yuv420p` video, audio absent or AAC, and a positive duration. Anything else → `failed` / `UNSUPPORTED_FORMAT`. A duration above `MAX_VIDEO_DURATION_SECONDS` (14 400) → `DURATION_LIMIT_EXCEEDED`.
2. **What is stored:** `duration_seconds` and `media_metadata` (format, brand, video codec, width, height, pixel format, audio codec, bit rate, size).
3. **ffmpeg** extracts one JPEG frame:
   - at 10 % of the duration, bounded to 1–10 s;
   - at the first frame for clips under 2 s.
4. **The thumbnail** is uploaded to the storage and `thumbnail_generated_at` is set, together with `ready`.

Scratch files live in a per-job temporary directory removed in `finally`.

### Storage layout (TD-03, TD-10, TD-16)

- **Buckets:**
  - `S3_BUCKET` (default `streamtube-videos`) for the application;
  - `S3_TEST_BUCKET` (default `streamtube-videos-test`, must end in `-test`) for the test suites only.
  Both are created by the provisioning step of the setup script, never by the application.
- **Keys** derive only from the internal UUID, never from the public id or the client filename:
  - `videos/<uuid>/original` for the uploaded file;
  - `videos/<uuid>/thumbnail.jpg` for the thumbnail.
- **Identities:** the API, the worker and the read-only delivery signer each use their own restricted MinIO identity. Root credentials never reach them. (Credential files: see "Development Environment".)
- **Public URL:** `public_id` is 11 random base62 characters with a unique index, regenerated on collision. It is the `:id` of every route.

### Streaming and download (TD-11)

`playback-url` and `download-url` return a presigned GET (`url`, `expires_at`) for the original, only when `processing_status = ready` (otherwise `409 VIDEO_NOT_READY`). The client then talks to MinIO directly:

- **Streaming:** MinIO serves HTTP Range (`206 Partial Content`), so playback never needs the full file. The client asks for a new URL before `expires_at` and keeps its position.
- **Download:** the URL carries `Content-Disposition: attachment` with the sanitized original filename (RFC 6266).

### Setup and tests

- **Setup:** `../scripts/setup.sh` (or `setup.ps1`) generates credentials, provisions MinIO, builds, migrates and starts the stack. `../scripts/verify.sh` runs the quick check; `../scripts/verify.sh --full` runs the full regression.
- **Test containers:** the integration, e2e and media suites run only in the ephemeral `test-api` / `test-worker` containers. See "Commands" and "Test execution" above; `npm run test:media` runs in `test-worker`.
- **Optional large-file check:** the 10 GiB end-to-end check (Verification Gate 3) is the explicit `npm run verify:large-upload` in `test-worker`, not part of any suite. The steps are in the root `README.md`, the approved result in `docs/phases/phase-03-videos/verification-10gib.md`.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
