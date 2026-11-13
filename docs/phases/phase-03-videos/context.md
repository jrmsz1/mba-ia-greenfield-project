---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-10T20:13:08-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-12T18:55:32-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-10T20:13:08-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-10T20:13:08-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-10T20:13:08-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-10T20:13:08-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-10T20:13:08-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos
**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._
**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.
**Affected subprojects:** No subprojects explicitly mentioned in the phase block (depends on Fase 01, Fase 02). The phase decisions doc scopes implementation to `nestjs-project/` only; `next-frontend/` has no decision or implementation in this phase.
**Deferred subprojects:** _None._
**Sequencing notes:** _None._ (Only the dependency line "Depende de: Fase 01, Fase 02".)

**Resolved boundary — Phase 03 × Phase 04 (AMB-1, resolved by `/plan-resolve` on 2026-11-11; recorded here because `project-plan.md` was not edited):**

- Phase 03 creates and processes the video as a **private draft**.
- `processing_status = ready` does **not** imply publication.
- Phase 04 owns the transition to published and the public visibility (and the editing of the video's information).
- Phase 03 keeps the `publication` state (TD-09) and the owner-only access until published (TD-12) so Phase 04 can extend them.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Large-file upload protocol and transport | decided | A (S3 multipart with per-part presigned URLs) | — |
| phase-03-videos/TD-02 | phase | Backend | Upload resumability, completion and cross-system consistency | decided | A (verified client manifest) | — |
|     └─ Last revision: 2026-11-12 — Upload-binding contradiction never deletes (Gate 4 review): when the object at… | | | | | | |
| phase-03-videos/TD-03 | phase | Backend | S3-compatible object storage server (MinIO) | decided | A (pinned MinIO from GitHub release asset, SHA-256-verified custom image) | — |
|     └─ Last revision: 2026-11-12 — Least-privilege provisioning (spike of 2026-11-12, matrix 66 cases × 2 runs): the pinned… | | | | | | |
| phase-03-videos/TD-04 | phase | Backend | S3 client library and endpoint/signing model | decided | A (AWS SDK v3, two endpoints) | `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x` |
|     └─ Last revision: 2026-11-12 — Least-privilege identities (spike of 2026-11-12 on the pinned build, matrix 66 cases… | | | | | | |
| phase-03-videos/TD-05 | phase | Backend | Background job queue and job-loss prevention | decided | A (pg-boss) | `pg-boss@^12.x` |
| phase-03-videos/TD-06 | phase | Backend | Media worker topology and responsibilities | decided | A (second entrypoint in nestjs-project) | — |
| phase-03-videos/TD-07 | phase | Backend | FFmpeg/ffprobe toolchain, validity rules and resource limits | decided | A (system ffmpeg/ffprobe via spawn) | — |
|     └─ Last revision: 2026-11-11 — Duration ceiling classified separately (plan-build review): a media file that… | | | | | | |
| phase-03-videos/TD-08 | phase | Backend | Processing input access and scratch storage | decided | A (HTTP Range over presigned GET) | — |
|     └─ Last revision: 2026-11-11 — Processing-input URL TTL key (AMB-3): the presigned GET the worker uses… | | | | | | |
| phase-03-videos/TD-09 | phase | Backend | Video lifecycle state machine and failure handling | decided | A (orthogonal publication and processing_status) | — |
|     └─ Last revision: 2026-11-12 — UPLOAD_INVALID transitions aligned with TD-02 (IC-3): `uploading`/`completing`… | | | | | | |
| phase-03-videos/TD-10 | phase | Backend | Unique public video identifier and storage keys | decided | A (random base62 id with unique index) | — |
| phase-03-videos/TD-11 | phase | Backend | HTTP streaming and download delivery | decided | A (presigned GET, Range directly on storage) | — |
|     └─ Last revision: 2026-11-11 — Distinct TTL keys (IC-2): playback URLs use `PLAYBACK_PRESIGN_TTL_SECONDS`… | | | | | | |
| phase-03-videos/TD-12 | phase | Backend | Authorization, ownership by channel and channel isolation | decided | A (owner-only until published, single policy function) | — |
| phase-03-videos/TD-13 | phase | Backend | Upload validation, abuse controls and untrusted-file handling | decided | A (layered controls) | — |
|     └─ Last revision: 2026-11-11 — Per-owner quota metric fixed (AMB-2): the per-owner quota counts **pending bytes**… | | | | | | |
| phase-03-videos/TD-14 | phase | Backend | Orphan resource cleanup and reconciliation | decided | A (scheduled reaper/reconciler) | — |
|     └─ Last revision: 2026-11-11 — Default ownership (AMB-2): the initial value of `COMPLETING_STALE_MINUTES` is set… | | | | | | |
| phase-03-videos/TD-15 | phase | Backend | Test strategy for storage, queue, worker and the API contract | decided | A (real services with isolation guards) | — |
|     └─ Last revision: 2026-11-12 — Ephemeral test containers (evaluator setup): the integration, e2e and media suites run in… | | | | | | |
| phase-03-videos/TD-16 | phase | Repo-wide | Docker Compose topology and environment contract | decided | A (extend nestjs-project/compose.yaml) | — |
|     └─ Last revision: 2026-11-12 — Per-service `env_file` credential delivery (evaluator setup): storage credentials reach… | | | | | | |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-15, phase-03-videos/TD-16 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-02, phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-14, phase-03-videos/TD-15, phase-03-videos/TD-16 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-01, phase-03-videos/TD-02, phase-03-videos/TD-04, phase-03-videos/TD-13, phase-03-videos/TD-14, phase-03-videos/TD-15 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-01, phase-03-videos/TD-02, phase-03-videos/TD-09, phase-03-videos/TD-12, phase-03-videos/TD-14 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-15 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-15 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-10 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-04, phase-03-videos/TD-11, phase-03-videos/TD-12, phase-03-videos/TD-15 |
| Download do vídeo pelo usuário | phase-03-videos/TD-04, phase-03-videos/TD-11, phase-03-videos/TD-12, phase-03-videos/TD-15 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** it is the only option that keeps the transfer off both Node processes, resumes natively, and is verifiable end to end with HTTP clients; its costs (client logic, endpoint reachability, part-size verification) are bounded and testable.
**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** it keeps the client's recorded manifest as the completion input, verifies it against storage before completing, and uses `HeadObject`, conditional transitions and reconciliation — never a timeout — to resolve the ambiguity of a lost `Complete` response; fall back to Option B only if the selected server's `ListParts` fails validation.
**Libraries:** —

**Revisions:**
- 2026-11-11 — Recovery rule aligned with TD-09 (IC-1): after `NoSuchUpload` or an ambiguous `CompleteMultipartUpload` outcome, a row in `uploading` or `completing` moves to `uploaded` only when the object at the video's storage key is proven to be the one this authorized upload produced — identity and integrity, not a matching size alone (this replaces "present with the declared size" in the failure matrix; the proof is Required Technical Verification Gate 4); when the upload is definitively lost, no valid object exists and `upload_expires_at` has not passed, the row moves to `failed` (`UPLOAD_LOST`); when expiry is proven (`upload_expires_at` has passed) and no valid object was completed, it moves to `expired`; a timeout, connection reset or 5xx is ambiguous and never by itself returns the row to `uploading` or marks it `failed` — it stays `completing` until the retried complete or the reconciler has evidence; compare-and-set transitions, idempotency and reconciliation are unchanged. Rationale: Revisar TD-09 e TD-02 — align the recovery matrix with the TD-09 transitions.
- 2026-11-12 — Upload-binding contradiction never deletes (Gate 4 review): when the object at the video's key carries an upload-binding different from upload_binding_token (or none), the completion is refused as failed/UPLOAD_INVALID, no job is published, the video is never delivered, and the object is NOT deleted automatically (its identity/authorization is unproven); it is retained and logged for investigation and later safe cleanup. Deletion remains only for an object that carries this upload's binding but contradicts the declared size or the manifest ETag, after a re-read immediately before the delete (the pinned MinIO ignores If-Match on DeleteObject). Decision A unchanged.

### phase-03-videos/TD-03

**Recommendation:** For the academic/local environment only — it is the only candidate whose behavior was demonstrated for every operation of this phase, it honors the brief's MinIO requirement, and the concrete blocker on the named source (`dl.min.io` 410) has a verified workaround (the GitHub release assets); Option D is not recommended merely because MinIO is unmaintained, and stays the documented fallback if the GitHub assets disappear or a smoke test of the built image fails.
**Libraries:** —

**Revisions:**
- 2026-11-12 — Least-privilege provisioning (spike of 2026-11-12, matrix 66 cases × 2 runs): the pinned server image is unchanged (`RELEASE.2025-09-07T16-13-09Z`, built image `sha256:080888beaa5d320726fa63ac5589129eb2a3d22d88d3fb6a623e28f74dafd656`) and gains no `mc`. Bucket and identity provisioning runs in a separate, ephemeral administrative container — never part of the operational services and the only place where the MinIO root credentials are used. Because the upstream `minio/mc` (Docker Hub) and `quay.io/minio/mc` images are not pullable, that container is built like the server image: base `debian:12-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc`, `mc` release asset `RELEASE.2025-08-13T08-35-41Z` verified by SHA-256 `01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891` at build time (a tampered checksum fails the build), resulting image `sha256:b38b632352ee75b12d3072e648a78c6a68ddc4b484cb0f7822ea3b09d9074ef2`. Provisioning is idempotent and fail-closed: it validates every existing resource before any write, then creates only what is missing, and never deletes, recreates or overwrites a bucket, object, user or policy (policies are content-addressed; a divergent existing user stops the run with no change). Provisioning now creates the configured bucket, replacing creation at application startup: API and worker only verify that the bucket exists and is accessible (HeadBucket) and fail fast otherwise. Provisioning does not rotate the secret of an existing user. Decision A unchanged.

### phase-03-videos/TD-04

**Recommendation:** portability and the demonstrated behavior (including the host-binding trap) outweigh the two-endpoint configuration cost.
**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

**Revisions:**
- 2026-11-12 — Least-privilege identities (spike of 2026-11-12 on the pinned build, matrix 66 cases × 2 runs, 64 as expected + 2 explained): the application no longer uses the MinIO root user. Three MinIO-managed identities scoped to the configured bucket replace the single credential pair: (1) API — multipart create/upload/complete/abort, ListParts, ListMultipartUploads, Head/Get and the guarded DeleteObject on `videos/*/original`, HeadBucket; it signs UploadPart URLs; (2) worker — Head/Get (including the internal presigned GET) and the reconciler's ListParts/ListMultipartUploads/Abort/guarded DeleteObject on originals, PutObject only on `videos/*/thumbnail.jpg`, HeadBucket; it cannot create or complete uploads; (3) delivery signer — read-only, GetObject on originals only; playback/download URLs carry its key ID, never the root's. The public signer is split into a part-URL signer (API identity) and a delivery signer (delivery identity). No operational identity can create buckets or use the admin API (both denied). Proven limitations, accepted: the API identity can perform a conventional PUT of an original (`s3:PutObject` also covers multipart; never used by the code, and a part URL cannot be replayed as one); the worker needs DeleteObject on originals for the authorized recovery flows (identity-proven only, enforced in code); the `s3:ListBucket` grant needed for HeadBucket also lets API and worker list object keys; ListBuckets returned only the authorized bucket in the executed tests (bucket-filtered, no foreign bucket name). No STS or external IAM. Decision A unchanged.

### phase-03-videos/TD-05

**Recommendation:** it reuses the PostgreSQL already in the stack, adds no service, and offers the retries, backoff, dead-lettering, heartbeat and scheduling this phase needs at the expected volume; it is conditional on the validation spike listed below, and if transactional enqueue does not work the fallback is a durable, documented and tested outbox/reconciliation on PostgreSQL — Redis is **not** introduced as a silent fallback (BullMQ stays a separately decided alternative).
**Libraries:** `pg-boss@^12.x`

### phase-03-videos/TD-06

**Recommendation:** it meets "worker independente" with the least duplication and leaves the existing layout and test baseline intact.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** two fixed commands do not justify a wrapper, and the deprecated one is a poor foundation; everything the brief asks (duration, metadata, thumbnail, invalid files, limits) was demonstrated with the raw binaries.
**Libraries:** —

**Revisions:**
- 2026-11-11 — Duration ceiling classified separately (plan-build review): a media file that satisfies the accepted-format rule (MP4-family container and brand, H.264 yuv420p, audio absent or AAC, duration > 0) but whose duration exceeds MAX_VIDEO_DURATION_SECONDS fails with the permanent, non-retried reason DURATION_LIMIT_EXCEEDED instead of UNSUPPORTED_FORMAT; UNSUPPORTED_FORMAT is reserved for media outside the accepted-format rule. Decision A unchanged. Rationale: a valid format that exceeds the duration limit is not an incompatible format.

### phase-03-videos/TD-08

**Recommendation:** processing reads by HTTP Range, falling back to a local copy (Option C) only if tests demonstrate it is needed; the measured seek behavior removes the need to copy large files for the operations this phase performs.
**Libraries:** —

**Revisions:**
- 2026-11-11 — Processing-input URL TTL key (AMB-3): the presigned GET the worker uses to read the stored video (signed with the internal endpoint, TD-04) uses `PROCESSING_INPUT_PRESIGN_TTL_SECONDS`; its initial value is set by `plan-build` as a configurable default, and configuration validation at startup rejects a value that is not greater than `WORKER_JOB_TIMEOUT_SECONDS` (the existing rule "the URL TTL must exceed the job timeout"); the URL stays a temporary credential, never logged or persisted (TD-07). Rationale: Chave própria.

### phase-03-videos/TD-09

**Recommendation:** it separates the two concerns the brief names and makes duplicate, retried and racing events harmless by construction.
**Libraries:** —

**Revisions:**
- 2026-11-11 — Transitions added to match the TD-02 recovery protocol (IC-1): `uploading` → `uploaded` when storage reports `NoSuchUpload` and the object at the video's key is proven to be this upload's (identity and integrity, not size alone), resolved by the retried complete or the reconciler; the existing `completing` → `uploaded` row requires the same identity proof instead of "the object with the declared size"; `uploading`/`completing` → `failed` (`UPLOAD_LOST`) when the upload is definitively lost, no valid object exists and `upload_expires_at` has not passed; `uploading`/`completing` → `expired` when `upload_expires_at` has passed (expiry proven) and no valid object was completed; a timeout, connection reset or 5xx causes no transition (`completing` stays `completing`: no return to `uploading`, no `failed`); every transition remains compare-and-set and idempotent. Rationale: Revisar TD-09 e TD-02 — align the transition table with the TD-02 recovery protocol.
- 2026-11-12 — UPLOAD_INVALID transitions aligned with TD-02 (IC-3): `uploading`/`completing` → `failed` (`UPLOAD_INVALID`) when the object at the video's key carries an upload-binding different from `upload_binding_token` (or none) — no job is published, the video is never delivered, and the object is retained (not deleted automatically) for investigation and later safe cleanup; the existing `completing` → `failed` row ("size/parts invalid after complete") keeps "object deleted" only for an object that carries this upload's binding but contradicts the declared size or the manifest ETag, after a re-read immediately before the delete; compare-and-set transitions and idempotency are unchanged. Rationale: Revisar TD-09 e TD-02 — align the transition table with the 2026-11-12 TD-02 revision.

### phase-03-videos/TD-10

**Recommendation:** the only option that is short and non-enumerable without a dependency; the unique index plus a bounded `ON CONFLICT` retry removes the collision risk without the aborted-transaction trap.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** it keeps the transfer off NestJS and Next.js, matches the planned architecture, preserves authorization at URL emission and was demonstrated on the pinned storage; the API proxy stays a documented future alternative (Option B) for when per-request authorization/revocation or strictly RFC-recommended Range responses become necessary.
**Libraries:** —

**Revisions:**
- 2026-11-11 — Distinct TTL keys (IC-2): playback URLs use `PLAYBACK_PRESIGN_TTL_SECONDS` (proposed initial value 3600) and download URLs use `DOWNLOAD_PRESIGN_TTL_SECONDS` (proposed initial value 900); the generic `PRESIGN_TTL_SECONDS` is removed; every TTL stays within the SigV4 presign maximum of 7 days (TD-04). Rationale: Nomear tudo, sem defaults — complete the canonical environment list (TD-16); TTL initial values as proposed in the resolution request.

### phase-03-videos/TD-12

**Recommendation:** the secure default for drafts at the cost of one function that Phases 04–05 extend.
**Libraries:** —

### phase-03-videos/TD-13

**Recommendation:** `ffprobe` is the authoritative parser, the state machine already provides the rejection path, and the size/part checks plus quotas close the abuse vectors that matter for this phase.
**Libraries:** —

**Revisions:**
- 2026-11-11 — Part URL TTL key (IC-2): per-part upload URLs use `UPLOAD_PART_PRESIGN_TTL_SECONDS` (proposed initial value 900) and stay re-requestable. Rationale: Nomear tudo, sem defaults — complete the canonical environment list (TD-16); TTL initial value as proposed in the resolution request.
- 2026-11-11 — Throttling scope made explicit (ICC-1): the existing `ThrottlerGuard` is bound globally (provided as `APP_GUARD` in `AuthModule`) with one unnamed policy `{ ttl: 60000, limit: 10 }`, so without action every Phase 03 route would inherit the authentication limit; the Phase 03 video controllers therefore opt out explicitly with `@SkipThrottle()` (affected routes: every Phase 03 video endpoint — start, part URLs, status/resume, complete, abort, playback/download URL emission), and "throttler limits on control endpoints" no longer applies. The Phase 02 authentication limits are unchanged and are not extended to video routes. Phase 03 abuse control relies on per-owner quotas (metric and key fixed during planning), a per-owner limit of simultaneous uploads (`MAX_ACTIVE_UPLOADS_PER_OWNER`), ownership validation (TD-12), idempotency (TD-02), size limits (`MAX_UPLOAD_BYTES`) and upload/URL expiry. Rationale: Opt-out explícito nas rotas de vídeo.
- 2026-11-11 — Per-owner quota metric fixed (AMB-2): the per-owner quota counts **pending bytes** — the sum of the declared sizes of the owner's uploads in `uploading` or `completing` — carried by `MAX_PENDING_UPLOAD_BYTES_PER_OWNER`; at start, a request whose declared size would push the sum above the limit, or that would exceed `MAX_ACTIVE_UPLOADS_PER_OWNER`, is rejected before any multipart upload is created; uploads leave the count on `uploaded`, `failed`, `expired` or abort; the residual risk already recorded (actual bytes can exceed the declared size until expiry/abort) is unchanged. Initial values of `MAX_PENDING_UPLOAD_BYTES_PER_OWNER` and `MAX_ACTIVE_UPLOADS_PER_OWNER` are set by `plan-build` as configurable defaults, each tested with small overrides. Rationale: Bytes pendentes; plan-build define defaults.

### phase-03-videos/TD-14

**Recommendation:** it works on the pinned build where Option B does not and also reconciles state; Option C stays an optional hardening for servers that enforce the lifecycle action.
**Libraries:** —

**Revisions:**
- 2026-11-11 — Threshold keys (IC-2): `UPLOAD_EXPIRY_HOURS` and `COMPLETING_STALE_MINUTES` are canonical keys (TD-16); no default value is decided for `COMPLETING_STALE_MINUTES` — it must be fixed during planning. Rationale: Nomear tudo, sem defaults.
- 2026-11-11 — Default ownership (AMB-2): the initial value of `COMPLETING_STALE_MINUTES` is set by `plan-build` as a configurable default, tested with small overrides. Rationale: Bytes pendentes; plan-build define defaults.

### phase-03-videos/TD-15

**Recommendation:** it keeps the project's testing pyramid and places the real-service checks where the highest risk lives; the guards must refuse any non-test bucket or queue schema before a reset.
**Libraries:** —

**Revisions:**
- 2026-11-12 — Isolated least-privilege integration-test storage (IC-4): The administrative provisioning process also creates and validates `S3_TEST_BUCKET` before integration suites run. Test workloads use the same least-privilege permission profiles defined by TD-04, instantiated as test-only identities or equivalent policies scoped exclusively to `S3_TEST_BUCKET`; production identities are not granted additional bucket access. Exceptional fixture preparation and destructive cleanup run outside the API and worker under a dedicated test-maintenance identity restricted to `S3_TEST_BUCKET`. Provisioning remains non-destructive and cannot be used for cleanup. Before any cleanup, the test runner must positively verify the configured target, its separation from the operational bucket, and the explicit test execution context; missing, identical, ambiguous or unauthorized targets fail closed. Negative-permission tests always use the restricted operational test identities, never the maintenance identity. No root credentials are supplied to API or worker. Existing data, development databases and backups must remain untouched. Decision A unchanged.
- 2026-11-12 — Test-maintenance runner and in-container test identities (IC-5, AMB-4): fixture preparation and destructive cleanup of `S3_TEST_BUCKET` run in an ephemeral, on-demand test-maintenance container — built and run like the provisioning container (TD-03), never a Compose service and never `nestjs-api` or `worker` — executed before and/or after the suite runs, never concurrently with them; it alone holds the `S3_TEST_MAINTENANCE_*` credentials (TD-16) and performs the positive target verification (configured target, separation from `S3_BUCKET`, explicit test execution context) before any delete, failing closed. The integration, e2e and media suites keep running inside `nestjs-api` and `worker` (`nestjs-project/CLAUDE.md`) but perform no destructive storage cleanup or bucket reset: their global setup only verifies the test-bucket target and fails closed when it is missing, equal to `S3_BUCKET`, ambiguous or unauthorized, and tests isolate their objects by unique keys; their storage clients use the restricted test identities (`S3_TEST_API_*`, `S3_TEST_WORKER_*`, `S3_TEST_DELIVERY_*`, TD-16), mapped onto the per-process clients only in the explicit test execution context. The test-database and queue-schema resets are unchanged. Decision A unchanged.
- 2026-11-12 — Ephemeral test containers (evaluator setup): the integration, e2e and media suites run in ephemeral test containers built from the same API and worker images (`test-api`, `test-worker`; separate test Compose file `compose.test.yaml`, profile-gated, started only with `run --rm`, never by `up`, never permanent), not inside the operational `nestjs-api` and `worker` containers (this supersedes "keep running inside `nestjs-api` and `worker`" of the 2026-11-12 IC-5/AMB-4 revision). Each test container receives only the restricted test identities through its own test env file (TD-16); the three `S3_TEST_*` identities may be present together for the multi-role scenarios, but no root, production or maintenance credential reaches a test process. Implementation requirements: (1) E2E isolation — `test-api` uses only the test database (`DB_TEST_NAME`), `S3_TEST_BUCKET`, the restricted test identities and the test queue schema (`PGBOSS_TEST_SCHEMA`); no test reaches the operational API, no test job is consumed by the operational worker and no test container consumes operational jobs; (2) lifecycle — the test containers run finite commands with no automatic restart, and the `test` profile is not treated as the isolation guarantee (the fail-closed guards are); (3) effective environment — `env_file`, `environment`, inherited variables and the dotenv-loaded `.env` are verified so that no configuration falls back to, or silently overrides, the restricted identities. The existing fail-closed guards (explicit test context, test-bucket verification, refusal of maintenance credentials, no fallback), the media suites in the FFmpeg-enabled worker image, the test-database and queue-schema resets, the external maintenance container and the per-test object isolation are unchanged. Decision A unchanged.

### phase-03-videos/TD-16

**Recommendation:** the smallest change that makes storage and worker reproducible, consistent with the existing per-subproject Compose files.
**Libraries:** —

**Revisions:**
- 2026-11-11 — Canonical key list completed (IC-2): `PRESIGN_TTL_SECONDS` is replaced by `UPLOAD_PART_PRESIGN_TTL_SECONDS` (proposed 900), `PLAYBACK_PRESIGN_TTL_SECONDS` (proposed 3600) and `DOWNLOAD_PRESIGN_TTL_SECONDS` (proposed 900); added `COMPLETING_STALE_MINUTES` (TD-14, default to be fixed during planning); keys named for values the TDs declare configurable, without decided defaults: `WORKER_CONCURRENCY`, `WORKER_JOB_TIMEOUT_SECONDS` and `MEDIA_PROBE_TIMEOUT_SECONDS` (worker limits and probing bounds, TD-05/TD-06/TD-07), `MAX_VIDEO_DURATION_SECONDS` (TD-07), `MAX_ACTIVE_UPLOADS_PER_OWNER` (TD-13), `PGBOSS_SCHEMA` (queue schema, TD-05), and the test-only isolation keys `S3_TEST_BUCKET` and `PGBOSS_TEST_SCHEMA` (TD-15, mirroring `DB_TEST_NAME`); the per-owner quota key is named together with its metric during planning. No backwards-compatible alias is introduced for `PRESIGN_TTL_SECONDS` (never implemented). Rationale: Nomear tudo, sem defaults.
- 2026-11-11 — Quota key and defaults (AMB-2): added `MAX_PENDING_UPLOAD_BYTES_PER_OWNER` (TD-13 per-owner pending-bytes quota); the initial values of `COMPLETING_STALE_MINUTES`, `MAX_ACTIVE_UPLOADS_PER_OWNER`, `MAX_PENDING_UPLOAD_BYTES_PER_OWNER`, `WORKER_CONCURRENCY`, `WORKER_JOB_TIMEOUT_SECONDS`, `MEDIA_PROBE_TIMEOUT_SECONDS` and `MAX_VIDEO_DURATION_SECONDS` are set by `plan-build` as configurable defaults (each overridable through the environment and tested with small values), keeping the TD-08 constraint that the worker's presigned input URL outlives `WORKER_JOB_TIMEOUT_SECONDS`. Rationale: Bytes pendentes; plan-build define defaults.
- 2026-11-11 — Processing-input TTL key (AMB-3): added `PROCESSING_INPUT_PRESIGN_TTL_SECONDS` (TD-08 worker input URL), default set by `plan-build`, validated at startup to be greater than `WORKER_JOB_TIMEOUT_SECONDS`; the canonical presign TTL keys are now `UPLOAD_PART_PRESIGN_TTL_SECONDS`, `PLAYBACK_PRESIGN_TTL_SECONDS`, `DOWNLOAD_PRESIGN_TTL_SECONDS` and `PROCESSING_INPUT_PRESIGN_TTL_SECONDS`. Rationale: Chave própria.
- 2026-11-12 — Per-process storage credentials (least-privilege spike of 2026-11-12): `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` become per-process values, mapped by Compose from `S3_API_ACCESS_KEY_ID`/`S3_API_SECRET_ACCESS_KEY` for `nestjs-api` and `S3_WORKER_ACCESS_KEY_ID`/`S3_WORKER_SECRET_ACCESS_KEY` for `worker`; new keys `S3_DELIVERY_ACCESS_KEY_ID`/`S3_DELIVERY_SECRET_ACCESS_KEY` for the API delivery signer; `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` are set only on the `minio` service and the ephemeral provisioning container — no root credential is ever sent to `nestjs-api` or `worker`; API and worker validate at startup the presence and consistency of their own storage credentials only (they never receive `MINIO_ROOT_USER` nor `MINIO_ROOT_PASSWORD`), while the provisioning/preflight step, which holds the root identifier, rejects any operational identity (API, worker or delivery) equal to the administrative one; the provisioning container (image `sha256:b38b632352ee75b12d3072e648a78c6a68ddc4b484cb0f7822ea3b09d9074ef2`, see TD-03) is run on demand and is not a Compose service; `.env.example` documents the names with empty values and no longer suggests reusing the root user. Decision A unchanged.
- 2026-11-12 — Test-only storage maintenance credentials (IC-4): The isolated integration-test environment may define `S3_TEST_MAINTENANCE_ACCESS_KEY_ID` and `S3_TEST_MAINTENANCE_SECRET_ACCESS_KEY` for an external fixture and cleanup mechanism, restricted to `S3_TEST_BUCKET`. These credentials are separate from root, production operational identities and the restricted identities exercised by tests. Provisioning/preflight verifies identity separation and rejects collisions. Maintenance credentials must not be injected into operational API or worker containers, exposed in logs, required by production configuration or accepted as a fallback when operational credentials are unavailable. The production Compose configuration remains independent of test maintenance. Provisioning itself remains non-destructive. Decision A unchanged.
- 2026-11-12 — Test identity keys (IC-5): added the test-only keys `S3_TEST_API_ACCESS_KEY_ID`/`S3_TEST_API_SECRET_ACCESS_KEY`, `S3_TEST_WORKER_ACCESS_KEY_ID`/`S3_TEST_WORKER_SECRET_ACCESS_KEY` and `S3_TEST_DELIVERY_ACCESS_KEY_ID`/`S3_TEST_DELIVERY_SECRET_ACCESS_KEY` for the restricted test identities of TD-15 (the TD-04 profiles scoped to `S3_TEST_BUCKET`); they may be passed to `nestjs-api` and `worker` for in-container test runs, and test setup maps them onto the per-process storage clients only in the explicit test execution context — never as a fallback for production configuration and never read by production startup; provisioning/preflight rejects any collision with root, the production operational identities or the test-maintenance identity; `.env.example` documents the names with empty values. Decision A unchanged.
- 2026-11-12 — Per-service `env_file` credential delivery (evaluator setup): storage credentials reach each container through Compose `env_file` files instead of interpolation from the project `.env`, one file per process role: `minio` ← `minio.env` (only `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`); `nestjs-api` ← `api.env` (only `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` of the API identity and `S3_DELIVERY_ACCESS_KEY_ID`/`S3_DELIVERY_SECRET_ACCESS_KEY`); `worker` ← `worker.env` (only `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` of the worker identity). The restricted test identities (`S3_TEST_API_*`, `S3_TEST_WORKER_*`, `S3_TEST_DELIVERY_*`) are no longer passed to the operational `nestjs-api` and `worker` containers (this supersedes the corresponding clause of the 2026-11-12 IC-5 revision): they live only in `test-api.env` and `test-worker.env`, consumed exclusively by ephemeral test containers built from the same API and worker images (TD-15). `provision.env` holds the provisioning inputs (root, `S3_API_*`, `S3_WORKER_*`, `S3_DELIVERY_*`, the test identities and `S3_TEST_MAINTENANCE_*`) for the on-demand provisioning container; `maintenance.env` holds only `S3_TEST_MAINTENANCE_*` and the test-database lock access for the on-demand maintenance container; neither is a Compose service. Consequently the operational API never receives root, maintenance or test credentials, and the operational worker never receives root, delivery, maintenance or test credentials. All files are generated by the setup scripts with random secrets, are never overwritten silently (an existing MinIO root pair is kept, so the existing data volume stays usable), are created with owner-only permissions, live in `<repo>/.local/secrets/` — a directory inside the checkout but git-ignored and outside every bind mount (only `nestjs-project/` is mounted into containers) — are referenced as required `env_file` paths, and their values are never printed. The bind-mounted `nestjs-project/.env` holds no storage or root credential; `.env.example` lists the credential names only as comments that point to the generated files. No shell variable is required; there is no default and no fallback to root or to production identities. Decision A unchanged.

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** (`@nestjs/swagger`) — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger
**Revisions:** 2026-05-12 — O CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). Enriquecimento via decoradores explícitos faz parte da Option A escolhida.

### openapi-docs-nestjs/TD-02

**Recommendation:** (Ambos) — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** (Apenas em dev/staging) — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` — Feature Implementation Checklist)_

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit (mock repo) + Integration (DB contract) |
| Service with DB only (no branching) | Integration (DB contract) |
| Service with configured lib (JWT, cache) | Unit with the real lib and test config |
| Service with side-effect dep (email, storage) | Integration with a real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — no unit tests |
| DTO | E2E: one validation-wiring test per endpoint |
| Guard (delegates to service) | E2E + Unit if complex internal logic |
| Guard (simple, Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom) | Unit |
| Interceptor | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

### next-frontend

_No testing requirements — `next-frontend/` has no decision or implementation in this phase._

### Required Technical Verification Gates

_Source: the "Future validations" list of `docs/decisions/technical-decisions-phase-03-videos.md`, carried here so that `plan-build` consumes it. These conditions do not reopen any decision and add no requirement to the phase scope. **All eight are PENDING — none has been executed or approved.**_

_Instruction to `plan-build`: assign each condition below to a Step Implementation, a spike, a test, or an acceptance criterion, and order them respecting their dependencies (for example, the TD-05 proof is the initial condition for planning the queue implementation, and the conditions that need real storage or the Compose infrastructure follow the MinIO build/run condition). The Phase 03 × Phase 04 boundary recorded under `## Scope` still applies: nothing here moves publication or public visibility into Phase 03._

| # | TD refs | Status | Required verification |
|---|---------|--------|-----------------------|
| 1 | phase-03-videos/TD-05 | PENDING | **TypeORM + `pg-boss`:** prove transactional integration — commit, rollback and durable recovery. This proof is the initial condition for planning the queue implementation. |
| 2 | phase-03-videos/TD-03, phase-03-videos/TD-16 | PENDING | **MinIO:** build a reproducible image of the pinned MinIO, verifying the SHA-256 during the build; validate Docker Compose, healthcheck and CORS. Preserve the additionally documented minisign signature check and the ARM64 asset checksum, as applicable. |
| 3 | phase-03-videos/TD-01, phase-03-videos/TD-08, phase-03-videos/TD-13 | PENDING | **10 GiB upload:** demonstrate multipart upload, resumption, completion and processing up to the defined limit. |
| 4 | phase-03-videos/TD-02 | PENDING | **Ambiguous completion:** prove the identity and integrity of the object found after a lost `CompleteMultipartUpload` response; do not rely only on a matching size. |
| 5 | phase-03-videos/TD-02, phase-03-videos/TD-09 | PENDING | **Concurrency:** test two simultaneous completions of the same video, ensuring conditional transitions and no duplicated effects. |
| 6 | phase-03-videos/TD-07, phase-03-videos/TD-15 | PENDING | **Real content:** create fixtures that prove MP4 container identification, H.264 video and optional AAC audio, without trusting the file extension alone. |
| 7 | phase-03-videos/TD-11 | PENDING | **Presigned URLs:** test expiry and renewal during prolonged playback. |
| 8 | phase-03-videos/TD-11 | PENDING | **Streaming:** prove HTTP Range directly on MinIO, using URLs emitted by the API and the real Compose infrastructure. |

## Decisions Implementation Detail

_Verbatim copy of the `**Implementation impact:**` field of each of the 16 TDs of `docs/decisions/technical-decisions-phase-03-videos.md`, carried here because `## Decisions Detail` holds only the short `Recommendation` prose and the plan needs this operational detail. Added by hand on 2026-11-11 with the user's approval; **no technical content was changed, no parameter was invented, and no decision was reopened**. The `Decision` of every TD is in `## Decisions Index`. A full `/plan-context` regeneration does not produce this section — it must be restored (or the pipeline contract extended) before rerunning it._

### phase-03-videos/TD-01 — Large-file upload protocol and transport

**Implementation impact:** API contract of five operations — start (returns video id, upload id, part size, expected part count, expiry), part URLs (batch by part number), status/resume (the parts found in storage with number, size and `ETag`, and the missing numbers), complete (carries the client's ordered manifest of part number + `ETag`, TD-02), abort of an incomplete upload — all owner-scoped (TD-12); default part size 64 MiB (160 parts for 10 GiB; 5 MiB is the S3 minimum and 10,000 parts the maximum, both configurable); presigned URL TTL configurable and re-requestable (SigV4 presign allows up to 7 days; shorter is the default); the start step stores `upload_id`, declared size, part size and expiry on the `videos` row (TD-02); no frontend is needed for tests (TD-15).

### phase-03-videos/TD-02 — Upload resumability, completion and cross-system consistency

**Implementation impact:** completion protocol, in order — (1) authorize (TD-12) and load the video: it must be `uploading` and not expired; (2) validate the client manifest: strictly ascending part numbers `1..N`, `N` equals the expected part count, well-formed `ETag`s; (3) read-only verification with paginated `ListParts` (`part-number-marker`/`NextPartNumberMarker`): every manifest entry matches a listed part by number, size and `ETag`, every non-last part has the agreed part size, the last is not larger, the sizes sum to the declared size, and there are no extra or missing parts — otherwise 409 with the missing/mismatched numbers so the client resumes, and `Complete` is **not** called; (4) claim with a conditional update (`uploading → completing`, `completing_since` set) — exactly one caller wins; (5) call `CompleteMultipartUpload` with the verified, ordered manifest; (6) on success, `HeadObject` on the video's unique key must report the declared size, then `completing → uploaded` and publish the job (TD-05); (7) **ambiguity rule** — once step 5 was issued, a timeout, connection reset, 5xx or lost response is ambiguous and the row **stays `completing`** (no automatic return to `uploading`); the retried `complete` or the reconciler resolves it with evidence: object present with the declared size → `uploaded`; object absent and `ListParts` still succeeds (upload open) → the claim may be released to `uploading`; object absent and `NoSuchUpload` → `failed` (`UPLOAD_LOST`); storage unreachable → remain `completing`, answer 202/503 with `Retry-After`; (8) a definitive rejection from `Complete` (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, other 4xx) proves the object was not created and may return the row to `uploading` with a 409. Failure matrix —

| Situation | Signal | Action |
|---|---|---|
| Start retried with the same key | unique (owner, key) | return the same video/upload; never create a second draft or multipart upload |
| Complete called twice or concurrently | claim updates 0 rows | read current status: past `uploading` → return it (200); `completing` → 202 with `Retry-After`; terminal failure → 409 |
| `NoSuchUpload` while the row is `uploading`/`completing` | 404 from S3 | `HeadObject` on the final key: present with the declared size → `uploaded` (completed by a lost response); absent → `failed`/`expired` (`UPLOAD_LOST`) |
| Parts missing, extra or mismatched | `ListParts` vs manifest | 409 with the details (client resumes); `Complete` not called |
| Complete outcome unknown (timeout/5xx/reset) | no definitive response | stay `completing`; reconcile with `HeadObject`/`ListParts`; never revert on the timeout alone |
| Object size ≠ declared after `Complete` | `HeadObject` | `failed` (`UPLOAD_INVALID`), delete the object |
| PostgreSQL commit fails after S3 `Complete` | row still `completing` | retried complete or reconciler finds the object and finishes the transition |
| Queue publish fails after the commit | `uploaded` without a job | same-transaction enqueue if validated (TD-05), else reconciler/outbox re-publishes with an idempotent job key |
| Storage unreachable **before** the claim (verification phase) | transport error | 503 `STORAGE_UNAVAILABLE` + `Retry-After`; nothing claimed; **no** cached fallback |
| Upload past `upload_expires_at` | reaper | abort (repeat until `ListParts` is empty), mark `expired` |

`complete` answers 404 for unknown or not-owned videos (TD-12).

_Revisions (copied from the decisions doc):_

- 2026-11-11 — Recovery rule aligned with TD-09 (IC-1): after `NoSuchUpload` or an ambiguous `CompleteMultipartUpload` outcome, a row in `uploading` or `completing` moves to `uploaded` only when the object at the video's storage key is proven to be the one this authorized upload produced — identity and integrity, not a matching size alone (this replaces "present with the declared size" in the failure matrix; the proof is Required Technical Verification Gate 4); when the upload is definitively lost, no valid object exists and `upload_expires_at` has not passed, the row moves to `failed` (`UPLOAD_LOST`); when expiry is proven (`upload_expires_at` has passed) and no valid object was completed, it moves to `expired`; a timeout, connection reset or 5xx is ambiguous and never by itself returns the row to `uploading` or marks it `failed` — it stays `completing` until the retried complete or the reconciler has evidence; compare-and-set transitions, idempotency and reconciliation are unchanged. Rationale: Revisar TD-09 e TD-02 — align the recovery matrix with the TD-09 transitions.
- 2026-11-12 — Upload-binding contradiction never deletes (Gate 4 review): when the object at the video's key carries an upload-binding different from upload_binding_token (or none), the completion is refused as failed/UPLOAD_INVALID, no job is published, the video is never delivered, and the object is NOT deleted automatically (its identity/authorization is unproven); it is retained and logged for investigation and later safe cleanup. Deletion remains only for an object that carries this upload's binding but contradicts the declared size or the manifest ETag, after a re-read immediately before the delete (the pinned MinIO ignores If-Match on DeleteObject). Decision A unchanged.

### phase-03-videos/TD-03 — S3-compatible object storage server (MinIO)

**Implementation impact:** future Dockerfile — versioned base image (`debian:12-slim` pinned by tag and digest), `ARG` for the release and the verified SHA-256 `7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f`, download from `https://github.com/minio/minio/releases/download/RELEASE.2025-09-07T16-13-09Z/minio.linux-amd64.RELEASE.2025-09-07T16-13-09Z`, `sha256sum -c` that fails the build (the published checksum file names the asset `minio.RELEASE…`, so compare the hash, not the filename), optional minisign verification with the public key found in the tag's `Dockerfile.release`, `curl` for the healthcheck, non-root user, `VOLUME /data`, `HEALTHCHECK` on `/minio/health/ready`, credentials from `.env`; the bucket is created by the application at startup (no `mc`); topology in TD-16.

_Revisions (copied from the decisions doc):_

- 2026-11-12 — Least-privilege provisioning (spike of 2026-11-12, matrix 66 cases × 2 runs): the pinned server image is unchanged (`RELEASE.2025-09-07T16-13-09Z`, built image `sha256:080888beaa5d320726fa63ac5589129eb2a3d22d88d3fb6a623e28f74dafd656`) and gains no `mc`. Bucket and identity provisioning runs in a separate, ephemeral administrative container — never part of the operational services and the only place where the MinIO root credentials are used. Because the upstream `minio/mc` (Docker Hub) and `quay.io/minio/mc` images are not pullable, that container is built like the server image: base `debian:12-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc`, `mc` release asset `RELEASE.2025-08-13T08-35-41Z` verified by SHA-256 `01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891` at build time (a tampered checksum fails the build), resulting image `sha256:b38b632352ee75b12d3072e648a78c6a68ddc4b484cb0f7822ea3b09d9074ef2`. Provisioning is idempotent and fail-closed: it validates every existing resource before any write, then creates only what is missing, and never deletes, recreates or overwrites a bucket, object, user or policy (policies are content-addressed; a divergent existing user stops the run with no change). Provisioning now creates the configured bucket, replacing creation at application startup: API and worker only verify that the bucket exists and is accessible (HeadBucket) and fail fast otherwise. Provisioning does not rotate the secret of an existing user. Decision A unchanged.

### phase-03-videos/TD-04 — S3 client library and endpoint/signing model

**Implementation impact:** credentials only from environment variables validated by Joi, never in code, `.env.example` or responses; the client only ever receives presigned URLs (TTL ≤ 7 days is the SigV4 presign maximum; short by default); a shared S3 module used by API and worker; configuration keys in TD-16.

_Revisions (copied from the decisions doc):_

- 2026-11-12 — Least-privilege identities (spike of 2026-11-12 on the pinned build, matrix 66 cases × 2 runs, 64 as expected + 2 explained): the application no longer uses the MinIO root user. Three MinIO-managed identities scoped to the configured bucket replace the single credential pair: (1) API — multipart create/upload/complete/abort, ListParts, ListMultipartUploads, Head/Get and the guarded DeleteObject on `videos/*/original`, HeadBucket; it signs UploadPart URLs; (2) worker — Head/Get (including the internal presigned GET) and the reconciler's ListParts/ListMultipartUploads/Abort/guarded DeleteObject on originals, PutObject only on `videos/*/thumbnail.jpg`, HeadBucket; it cannot create or complete uploads; (3) delivery signer — read-only, GetObject on originals only; playback/download URLs carry its key ID, never the root's. The public signer is split into a part-URL signer (API identity) and a delivery signer (delivery identity). No operational identity can create buckets or use the admin API (both denied). Proven limitations, accepted: the API identity can perform a conventional PUT of an original (`s3:PutObject` also covers multipart; never used by the code, and a part URL cannot be replayed as one); the worker needs DeleteObject on originals for the authorized recovery flows (identity-proven only, enforced in code); the `s3:ListBucket` grant needed for HeadBucket also lets API and worker list object keys; ListBuckets returned only the authorized bucket in the executed tests (bucket-filtered, no foreign bucket name). No STS or external IAM. Decision A unchanged.

### phase-03-videos/TD-05 — Background job queue and job-loss prevention

**Implementation impact:** job key = video id (idempotent publication); handler idempotent (same outputs overwrite the same keys); retry with backoff for transient errors, dead-letter/`failed` for permanent ones (TD-09); worker graceful stop on `SIGTERM`; `expireInSeconds` and optional heartbeat sized to the longest job; the API only publishes, the worker consumes (TD-06). **Planning condition — the spike must prove:** (1) the chosen `pg-boss` version is compatible with the installed TypeORM and `pg` (it requires `pg ^8.23.1`; the repo has 8.20.0); (2) `send(…, { db })` enqueues inside the **same transaction** as the video state change, through an adapter over TypeORM's underlying connection; (3) a **rollback** publishes no job; (4) a **commit** preserves both the video state and the job; (5) the `pgboss` schema is initialized deterministically (library installation, or DDL from `getConstructionPlans()` applied by a migration) and (6) is isolated and reset in the tests; (7) deduplication by key, retries with backoff, heartbeat and recovery of interrupted jobs behave as documented; (8) **no database transaction stays open while a video is being processed** — claims are short and processing runs outside any transaction. The spike result is a validation condition of the planning stage; if (2)–(4) fail, implement the outbox/reconciliation fallback (the `uploaded` row as durable intent plus the reconciler of TD-14) with its own tests.

### phase-03-videos/TD-06 — Media worker topology and responsibilities

**Implementation impact:** Compose service `worker` (same code, FFmpeg-enabled image target, `depends_on` the database and storage health), CPU/memory limits on that service, non-root user, no published ports; shared S3 and queue modules; entrypoint file and build target are implementation details for `plan-build`.

### phase-03-videos/TD-07 — FFmpeg/ffprobe toolchain, validity rules and resource limits

**Implementation impact:** **accepted media (human decision):** MP4 with H.264 video and optional AAC audio; everything else is rejected as unsupported (`failed`, reason `UNSUPPORTED_FORMAT`, permanent, no retry) with no transcoding promised. The rule is decided from the probe, **never from the file extension or the declared MIME**: container `format_name` contains `mp4` **and** `major_brand` belongs to an MP4-family allowlist (E5: MP4 → `isom`; MOV → `qt  ` and 3GP → `3gp6` share the same `format_name` and are told apart only by the brand; an MKV saved as `.mp4` reports `matroska,webm`), first video stream codec `h264` (HEVC, VP9… rejected) with pixel format `yuv420p` (a 4:4:4 stream is rejected as a playback-compatibility policy), audio absent or `aac` (MP3… rejected), duration > 0 (and ≤ a configured maximum); only the brand `isom` was observed in E5, so the allowlist is completed with fixtures in the plan; failure classification by cause: invalid media (permanent) vs storage/network (transient → retry) — classify by stderr pattern or by a `HeadObject` pre-check, not by exit code; the thumbnail position is a policy (a fraction of the duration with lower/upper bounds, start for very short clips); the thumbnail is written to a per-job temp directory, uploaded through the SDK, and the directory is removed in a `finally` block on success and failure; no transcoding, HLS or multiple resolutions in this phase (documented evolution).

_Revisions (copied from the decisions doc):_

- 2026-11-11 — Duration ceiling classified separately (plan-build review): a media file that satisfies the accepted-format rule (MP4-family container and brand, H.264 yuv420p, audio absent or AAC, duration > 0) but whose duration exceeds MAX_VIDEO_DURATION_SECONDS fails with the permanent, non-retried reason DURATION_LIMIT_EXCEEDED instead of UNSUPPORTED_FORMAT; UNSUPPORTED_FORMAT is reserved for media outside the accepted-format rule. Decision A unchanged. Rationale: a valid format that exceeds the duration limit is not an incompatible format.

### phase-03-videos/TD-08 — Processing input access and scratch storage

**Implementation impact:** the worker presigns with the **internal** endpoint (TD-04); a `finally` block removes the per-job temp directory; if Option C is adopted, size scratch space as concurrency × maximum object size.

_Revisions (copied from the decisions doc):_

- 2026-11-11 — Processing-input URL TTL key (AMB-3): the presigned GET the worker uses to read the stored video (signed with the internal endpoint, TD-04) uses `PROCESSING_INPUT_PRESIGN_TTL_SECONDS`; its initial value is set by `plan-build` as a configurable default, and configuration validation at startup rejects a value that is not greater than `WORKER_JOB_TIMEOUT_SECONDS` (the existing rule "the URL TTL must exceed the job timeout"); the URL stays a temporary credential, never logged or persisted (TD-07). Rationale: Chave própria.

### phase-03-videos/TD-09 — Video lifecycle state machine and failure handling

**Implementation impact:** transition table —

| From | Event / guard | To | Notes |
|---|---|---|---|
| — | start upload (idempotency key) | `uploading` | creates the draft video and the multipart upload |
| `uploading` | complete requested (claim) | `completing` | exactly one caller wins |
| `completing` | parts + size valid, S3 complete OK | `uploaded` | processing pending; job published (TD-05) |
| `completing` | `HeadObject` shows the object with the declared size (lost `Complete` response) | `uploaded` | resolved by the retried complete or the reconciler (TD-02) |
| `completing` | definitive rejection by `Complete`, or evidence that the object was not created and the upload is still open | `uploading` | never on a timeout alone; the evidence is recorded |
| `completing` | size/parts invalid after complete | `failed` | reason `UPLOAD_INVALID`; object deleted |
| `completing` | object absent and the upload is gone (`NoSuchUpload`) | `failed` | reason `UPLOAD_LOST` |
| `uploading` | owner aborts | `cancelled` | multipart aborted (an incomplete upload only) |
| `uploading` | the storage no longer has the upload (`NoSuchUpload`) and no object exists | `failed` | reason `UPLOAD_LOST` (TD-02) |
| `uploading` | past `upload_expires_at` | `expired` | by the reaper |
| `uploaded` | worker claims the job | `processing` | records attempt and start time |
| `processing` | metadata + thumbnail persisted | `ready` | terminal success |
| `processing` | transient error, attempts left | `processing` (re-claimed) | queue retry with backoff; stale claims re-run idempotently |
| `processing` | permanent error (invalid or unsupported media, `UNSUPPORTED_FORMAT`) or retries exhausted | `failed` | reason stored, free of URLs and signature parameters |

Duplicate/late events are ignored (zero rows); handlers produce the same outputs when re-run; `ready`, `failed`, `expired`, `cancelled` are terminal in this phase.

_Revisions (copied from the decisions doc):_

- 2026-11-11 — Transitions added to match the TD-02 recovery protocol (IC-1): `uploading` → `uploaded` when storage reports `NoSuchUpload` and the object at the video's key is proven to be this upload's (identity and integrity, not size alone), resolved by the retried complete or the reconciler; the existing `completing` → `uploaded` row requires the same identity proof instead of "the object with the declared size"; `uploading`/`completing` → `failed` (`UPLOAD_LOST`) when the upload is definitively lost, no valid object exists and `upload_expires_at` has not passed; `uploading`/`completing` → `expired` when `upload_expires_at` has passed (expiry proven) and no valid object was completed; a timeout, connection reset or 5xx causes no transition (`completing` stays `completing`: no return to `uploading`, no `failed`); every transition remains compare-and-set and idempotent. Rationale: Revisar TD-09 e TD-02 — align the transition table with the TD-02 recovery protocol.
- 2026-11-12 — UPLOAD_INVALID transitions aligned with TD-02 (IC-3): `uploading`/`completing` → `failed` (`UPLOAD_INVALID`) when the object at the video's key carries an upload-binding different from `upload_binding_token` (or none) — no job is published, the video is never delivered, and the object is retained (not deleted automatically) for investigation and later safe cleanup; the existing `completing` → `failed` row ("size/parts invalid after complete") keeps "object deleted" only for an object that carries this upload's binding but contradicts the declared size or the manifest ETag, after a re-read immediately before the delete; compare-and-set transitions and idempotency are unchanged. Rationale: Revisar TD-09 e TD-02 — align the transition table with the 2026-11-12 TD-02 revision.

### phase-03-videos/TD-10 — Unique public video identifier and storage keys

**Implementation impact:** `videos.public_id` with a `UNIQUE` constraint, generated at the draft step; **storage keys are derived only from the internal UUID primary key** (e.g., `videos/<uuid>/original`, `videos/<uuid>/thumbnail.jpg`), never from `public_id` or from the client's filename; the original filename is stored as sanitized metadata used only for `Content-Disposition` (TD-11).

### phase-03-videos/TD-11 — HTTP streaming and download delivery

**Implementation impact:** behavior to specify and test — emission is owner-only (TD-12) and returns `{ url, expires_at }`; videos not `ready` are refused with a domain error (e.g., `VIDEO_NOT_READY`, 409); another channel's video → 404; TTLs are configurable (proposed defaults: playback 1 hour, download 15 minutes) and the client renews by requesting a new URL before `expires_at`, swapping the source and keeping the playback position; the response never contains permanent credentials (only the presigned URL and its expiry); the URL is presigned for the **public** endpoint (TD-04). Tests: API level with `supertest` — authorization, `ready`-only, channel isolation, `no-store`, no credential material in the body; storage level with plain `fetch` against the emitted URL — `206` with `Content-Range`/`Content-Length`/`Accept-Ranges` for a valid range, `200` for an invalid range (permitted), `416` for an unsatisfiable range (without asserting a `Content-Range` the pinned build does not send), `Content-Disposition` on the download URL, `403` after expiry and for an unsigned request.

_Revisions (copied from the decisions doc):_

- 2026-11-11 — Distinct TTL keys (IC-2): playback URLs use `PLAYBACK_PRESIGN_TTL_SECONDS` (proposed initial value 3600) and download URLs use `DOWNLOAD_PRESIGN_TTL_SECONDS` (proposed initial value 900); the generic `PRESIGN_TTL_SECONDS` is removed; every TTL stays within the SigV4 presign maximum of 7 days (TD-04). Rationale: Nomear tudo, sem defaults — complete the canonical environment list (TD-16); TTL initial values as proposed in the resolution request.

### phase-03-videos/TD-12 — Authorization, ownership by channel and channel isolation

**Implementation impact:** authorization matrix —

| Operation | Rule |
|---|---|
| start upload | authenticated user with a channel; video created under that channel |
| part URLs, status/resume, complete, abort | owner of the video's channel, video in an allowed state |
| emit playback / download URL | owner of the video's channel; `ready` only (other states → 409); others later per Phases 04–05 |
| any operation on another channel's video | 404 `VIDEO_NOT_FOUND`, never reveals existence |

Channel-isolation tests: a second authenticated user cannot start-with, complete, abort, list parts of, stream or download the first user's video (TD-15).

### phase-03-videos/TD-13 — Upload validation, abuse controls and untrusted-file handling

**Implementation impact:** server-generated object keys only (TD-10); filenames sanitized (strip paths/control characters, RFC 6266 encoding) and used only for `Content-Disposition`; per-part URL TTL short and re-requestable; abort as the operational revocation (verified to invalidate outstanding part URLs); throttler limits on control endpoints (existing `@nestjs/throttler`, in-memory, single instance); worker runs as a non-root user without a shell, with timeouts and Compose resource limits; remove presigned URLs and every signature/credential parameter from logs and stored failure reasons (never persist a presigned URL); `MAX_UPLOAD_BYTES` configurable so the limit logic is tested with small values.

_Revisions (copied from the decisions doc):_

- 2026-11-11 — Part URL TTL key (IC-2): per-part upload URLs use `UPLOAD_PART_PRESIGN_TTL_SECONDS` (proposed initial value 900) and stay re-requestable. Rationale: Nomear tudo, sem defaults — complete the canonical environment list (TD-16); TTL initial value as proposed in the resolution request.
- 2026-11-11 — Throttling scope made explicit (ICC-1): the existing `ThrottlerGuard` is bound globally (provided as `APP_GUARD` in `AuthModule`) with one unnamed policy `{ ttl: 60000, limit: 10 }`, so without action every Phase 03 route would inherit the authentication limit; the Phase 03 video controllers therefore opt out explicitly with `@SkipThrottle()` (affected routes: every Phase 03 video endpoint — start, part URLs, status/resume, complete, abort, playback/download URL emission), and "throttler limits on control endpoints" no longer applies. The Phase 02 authentication limits are unchanged and are not extended to video routes. Phase 03 abuse control relies on per-owner quotas (metric and key fixed during planning), a per-owner limit of simultaneous uploads (`MAX_ACTIVE_UPLOADS_PER_OWNER`), ownership validation (TD-12), idempotency (TD-02), size limits (`MAX_UPLOAD_BYTES`) and upload/URL expiry. Rationale: Opt-out explícito nas rotas de vídeo.
- 2026-11-11 — Per-owner quota metric fixed (AMB-2): the per-owner quota counts **pending bytes** — the sum of the declared sizes of the owner's uploads in `uploading` or `completing` — carried by `MAX_PENDING_UPLOAD_BYTES_PER_OWNER`; at start, a request whose declared size would push the sum above the limit, or that would exceed `MAX_ACTIVE_UPLOADS_PER_OWNER`, is rejected before any multipart upload is created; uploads leave the count on `uploaded`, `failed`, `expired` or abort; the residual risk already recorded (actual bytes can exceed the declared size until expiry/abort) is unchanged. Initial values of `MAX_PENDING_UPLOAD_BYTES_PER_OWNER` and `MAX_ACTIVE_UPLOADS_PER_OWNER` are set by `plan-build` as configurable defaults, each tested with small overrides. Rationale: Bytes pendentes; plan-build define defaults.

### phase-03-videos/TD-14 — Orphan resource cleanup and reconciliation

**Implementation impact:** reaper/reconciler scheduled through the queue (TD-05) and executed by the worker (TD-06); configurable thresholds (`UPLOAD_EXPIRY_HOURS`, `COMPLETING_STALE_MINUTES`); abort is repeated until `ListParts` is empty; every action transitions state through the same compare-and-set rules (TD-09).

_Revisions (copied from the decisions doc):_

- 2026-11-11 — Threshold keys (IC-2): `UPLOAD_EXPIRY_HOURS` and `COMPLETING_STALE_MINUTES` are canonical keys (TD-16); no default value is decided for `COMPLETING_STALE_MINUTES` — it must be fixed during planning. Rationale: Nomear tudo, sem defaults.
- 2026-11-11 — Default ownership (AMB-2): the initial value of `COMPLETING_STALE_MINUTES` is set by `plan-build` as a configurable default, tested with small overrides. Rationale: Bytes pendentes; plan-build define defaults.

### phase-03-videos/TD-15 — Test strategy for storage, queue, worker and the API contract (no frontend)

**Implementation impact:** fixtures — a valid MP4 with `faststart`, one with the `moov` atom at the end, random bytes, a text file and a truncated MP4; contract tests for each API operation (start, part URLs, resume, complete, abort, status, playback/download URL emission) and storage-level tests with plain `fetch` against the emitted URLs (`Range` cases, `Content-Disposition`, expiry — TD-11); media-rule fixtures — accepted: H.264+AAC and H.264 without audio; rejected: HEVC, VP9/WebM, MKV saved as `.mp4`, MOV, 3GP, 4:4:4 H.264, MP3 audio, truncated file, random bytes, text; a redaction test asserting that no `X-Amz-*` parameter or presigned URL is logged or persisted; concurrency tests (parallel completes, duplicate start with the same key, duplicate job delivery); failure injection (storage unavailable → 503 without cached fallback; a lost `Complete` response → the row stays `completing` and is reconciled with `HeadObject`; queue publish failure → reconciler/outbox repairs; the `pg-boss` spike conditions of TD-05); channel-isolation tests (TD-12); reaper tests (expired upload aborted, stale claim resolved); all run inside the container per `nestjs-project/CLAUDE.md`.

_Revisions (copied from the decisions doc):_

- 2026-11-12 — Isolated least-privilege integration-test storage (IC-4): The administrative provisioning process also creates and validates `S3_TEST_BUCKET` before integration suites run. Test workloads use the same least-privilege permission profiles defined by TD-04, instantiated as test-only identities or equivalent policies scoped exclusively to `S3_TEST_BUCKET`; production identities are not granted additional bucket access. Exceptional fixture preparation and destructive cleanup run outside the API and worker under a dedicated test-maintenance identity restricted to `S3_TEST_BUCKET`. Provisioning remains non-destructive and cannot be used for cleanup. Before any cleanup, the test runner must positively verify the configured target, its separation from the operational bucket, and the explicit test execution context; missing, identical, ambiguous or unauthorized targets fail closed. Negative-permission tests always use the restricted operational test identities, never the maintenance identity. No root credentials are supplied to API or worker. Existing data, development databases and backups must remain untouched. Decision A unchanged.
- 2026-11-12 — Test-maintenance runner and in-container test identities (IC-5, AMB-4): fixture preparation and destructive cleanup of `S3_TEST_BUCKET` run in an ephemeral, on-demand test-maintenance container — built and run like the provisioning container (TD-03), never a Compose service and never `nestjs-api` or `worker` — executed before and/or after the suite runs, never concurrently with them; it alone holds the `S3_TEST_MAINTENANCE_*` credentials (TD-16) and performs the positive target verification (configured target, separation from `S3_BUCKET`, explicit test execution context) before any delete, failing closed. The integration, e2e and media suites keep running inside `nestjs-api` and `worker` (`nestjs-project/CLAUDE.md`) but perform no destructive storage cleanup or bucket reset: their global setup only verifies the test-bucket target and fails closed when it is missing, equal to `S3_BUCKET`, ambiguous or unauthorized, and tests isolate their objects by unique keys; their storage clients use the restricted test identities (`S3_TEST_API_*`, `S3_TEST_WORKER_*`, `S3_TEST_DELIVERY_*`, TD-16), mapped onto the per-process clients only in the explicit test execution context. The test-database and queue-schema resets are unchanged. Decision A unchanged.
- 2026-11-12 — Ephemeral test containers (evaluator setup): the integration, e2e and media suites run in ephemeral test containers built from the same API and worker images (`test-api`, `test-worker`; separate test Compose file `compose.test.yaml`, profile-gated, started only with `run --rm`, never by `up`, never permanent), not inside the operational `nestjs-api` and `worker` containers (this supersedes "keep running inside `nestjs-api` and `worker`" of the 2026-11-12 IC-5/AMB-4 revision). Each test container receives only the restricted test identities through its own test env file (TD-16); the three `S3_TEST_*` identities may be present together for the multi-role scenarios, but no root, production or maintenance credential reaches a test process. Implementation requirements: (1) E2E isolation — `test-api` uses only the test database (`DB_TEST_NAME`), `S3_TEST_BUCKET`, the restricted test identities and the test queue schema (`PGBOSS_TEST_SCHEMA`); no test reaches the operational API, no test job is consumed by the operational worker and no test container consumes operational jobs; (2) lifecycle — the test containers run finite commands with no automatic restart, and the `test` profile is not treated as the isolation guarantee (the fail-closed guards are); (3) effective environment — `env_file`, `environment`, inherited variables and the dotenv-loaded `.env` are verified so that no configuration falls back to, or silently overrides, the restricted identities. The existing fail-closed guards (explicit test context, test-bucket verification, refusal of maintenance credentials, no fallback), the media suites in the FFmpeg-enabled worker image, the test-database and queue-schema resets, the external maintenance container and the per-test object isolation are unchanged. Decision A unchanged.

### phase-03-videos/TD-16 — Docker Compose topology and environment contract for storage and worker

**Implementation impact:** canonical environment keys (names only, with Joi validation, `compose.yaml` and `.env.example` kept in sync, empty or placeholder values in tracked files): `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_API_CORS_ALLOW_ORIGIN`, `MAX_UPLOAD_BYTES`, `UPLOAD_PART_SIZE_BYTES`, `PRESIGN_TTL_SECONDS`, `UPLOAD_EXPIRY_HOURS`, worker limits (concurrency, job timeout, probing bounds), and the test-only bucket/guard keys of TD-15; the `worker` service uses an image target with FFmpeg, resource limits and no published ports.

_Revisions (copied from the decisions doc):_

- 2026-11-11 — Canonical key list completed (IC-2): `PRESIGN_TTL_SECONDS` is replaced by `UPLOAD_PART_PRESIGN_TTL_SECONDS` (proposed 900), `PLAYBACK_PRESIGN_TTL_SECONDS` (proposed 3600) and `DOWNLOAD_PRESIGN_TTL_SECONDS` (proposed 900); added `COMPLETING_STALE_MINUTES` (TD-14, default to be fixed during planning); keys named for values the TDs declare configurable, without decided defaults: `WORKER_CONCURRENCY`, `WORKER_JOB_TIMEOUT_SECONDS` and `MEDIA_PROBE_TIMEOUT_SECONDS` (worker limits and probing bounds, TD-05/TD-06/TD-07), `MAX_VIDEO_DURATION_SECONDS` (TD-07), `MAX_ACTIVE_UPLOADS_PER_OWNER` (TD-13), `PGBOSS_SCHEMA` (queue schema, TD-05), and the test-only isolation keys `S3_TEST_BUCKET` and `PGBOSS_TEST_SCHEMA` (TD-15, mirroring `DB_TEST_NAME`); the per-owner quota key is named together with its metric during planning. No backwards-compatible alias is introduced for `PRESIGN_TTL_SECONDS` (never implemented). Rationale: Nomear tudo, sem defaults.
- 2026-11-11 — Quota key and defaults (AMB-2): added `MAX_PENDING_UPLOAD_BYTES_PER_OWNER` (TD-13 per-owner pending-bytes quota); the initial values of `COMPLETING_STALE_MINUTES`, `MAX_ACTIVE_UPLOADS_PER_OWNER`, `MAX_PENDING_UPLOAD_BYTES_PER_OWNER`, `WORKER_CONCURRENCY`, `WORKER_JOB_TIMEOUT_SECONDS`, `MEDIA_PROBE_TIMEOUT_SECONDS` and `MAX_VIDEO_DURATION_SECONDS` are set by `plan-build` as configurable defaults (each overridable through the environment and tested with small values), keeping the TD-08 constraint that the worker's presigned input URL outlives `WORKER_JOB_TIMEOUT_SECONDS`. Rationale: Bytes pendentes; plan-build define defaults.
- 2026-11-11 — Processing-input TTL key (AMB-3): added `PROCESSING_INPUT_PRESIGN_TTL_SECONDS` (TD-08 worker input URL), default set by `plan-build`, validated at startup to be greater than `WORKER_JOB_TIMEOUT_SECONDS`; the canonical presign TTL keys are now `UPLOAD_PART_PRESIGN_TTL_SECONDS`, `PLAYBACK_PRESIGN_TTL_SECONDS`, `DOWNLOAD_PRESIGN_TTL_SECONDS` and `PROCESSING_INPUT_PRESIGN_TTL_SECONDS`. Rationale: Chave própria.
- 2026-11-12 — Per-process storage credentials (least-privilege spike of 2026-11-12): `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` become per-process values, mapped by Compose from `S3_API_ACCESS_KEY_ID`/`S3_API_SECRET_ACCESS_KEY` for `nestjs-api` and `S3_WORKER_ACCESS_KEY_ID`/`S3_WORKER_SECRET_ACCESS_KEY` for `worker`; new keys `S3_DELIVERY_ACCESS_KEY_ID`/`S3_DELIVERY_SECRET_ACCESS_KEY` for the API delivery signer; `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` are set only on the `minio` service and the ephemeral provisioning container — no root credential is ever sent to `nestjs-api` or `worker`; API and worker validate at startup the presence and consistency of their own storage credentials only (they never receive `MINIO_ROOT_USER` nor `MINIO_ROOT_PASSWORD`), while the provisioning/preflight step, which holds the root identifier, rejects any operational identity (API, worker or delivery) equal to the administrative one; the provisioning container (image `sha256:b38b632352ee75b12d3072e648a78c6a68ddc4b484cb0f7822ea3b09d9074ef2`, see TD-03) is run on demand and is not a Compose service; `.env.example` documents the names with empty values and no longer suggests reusing the root user. Decision A unchanged.
- 2026-11-12 — Test-only storage maintenance credentials (IC-4): The isolated integration-test environment may define `S3_TEST_MAINTENANCE_ACCESS_KEY_ID` and `S3_TEST_MAINTENANCE_SECRET_ACCESS_KEY` for an external fixture and cleanup mechanism, restricted to `S3_TEST_BUCKET`. These credentials are separate from root, production operational identities and the restricted identities exercised by tests. Provisioning/preflight verifies identity separation and rejects collisions. Maintenance credentials must not be injected into operational API or worker containers, exposed in logs, required by production configuration or accepted as a fallback when operational credentials are unavailable. The production Compose configuration remains independent of test maintenance. Provisioning itself remains non-destructive. Decision A unchanged.
- 2026-11-12 — Test identity keys (IC-5): added the test-only keys `S3_TEST_API_ACCESS_KEY_ID`/`S3_TEST_API_SECRET_ACCESS_KEY`, `S3_TEST_WORKER_ACCESS_KEY_ID`/`S3_TEST_WORKER_SECRET_ACCESS_KEY` and `S3_TEST_DELIVERY_ACCESS_KEY_ID`/`S3_TEST_DELIVERY_SECRET_ACCESS_KEY` for the restricted test identities of TD-15 (the TD-04 profiles scoped to `S3_TEST_BUCKET`); they may be passed to `nestjs-api` and `worker` for in-container test runs, and test setup maps them onto the per-process storage clients only in the explicit test execution context — never as a fallback for production configuration and never read by production startup; provisioning/preflight rejects any collision with root, the production operational identities or the test-maintenance identity; `.env.example` documents the names with empty values. Decision A unchanged.
- 2026-11-12 — Per-service `env_file` credential delivery (evaluator setup): storage credentials reach each container through Compose `env_file` files instead of interpolation from the project `.env`, one file per process role: `minio` ← `minio.env` (only `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`); `nestjs-api` ← `api.env` (only `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` of the API identity and `S3_DELIVERY_ACCESS_KEY_ID`/`S3_DELIVERY_SECRET_ACCESS_KEY`); `worker` ← `worker.env` (only `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` of the worker identity). The restricted test identities (`S3_TEST_API_*`, `S3_TEST_WORKER_*`, `S3_TEST_DELIVERY_*`) are no longer passed to the operational `nestjs-api` and `worker` containers (this supersedes the corresponding clause of the 2026-11-12 IC-5 revision): they live only in `test-api.env` and `test-worker.env`, consumed exclusively by ephemeral test containers built from the same API and worker images (TD-15). `provision.env` holds the provisioning inputs (root, `S3_API_*`, `S3_WORKER_*`, `S3_DELIVERY_*`, the test identities and `S3_TEST_MAINTENANCE_*`) for the on-demand provisioning container; `maintenance.env` holds only `S3_TEST_MAINTENANCE_*` and the test-database lock access for the on-demand maintenance container; neither is a Compose service. Consequently the operational API never receives root, maintenance or test credentials, and the operational worker never receives root, delivery, maintenance or test credentials. All files are generated by the setup scripts with random secrets, are never overwritten silently (an existing MinIO root pair is kept, so the existing data volume stays usable), are created with owner-only permissions, live in `<repo>/.local/secrets/` — a directory inside the checkout but git-ignored and outside every bind mount (only `nestjs-project/` is mounted into containers) — are referenced as required `env_file` paths, and their values are never printed. The bind-mounted `nestjs-project/.env` holds no storage or root credential; `.env.example` lists the credential names only as comments that point to the generated files. No shell variable is required; there is no default and no fallback to root or to production identities. Decision A unchanged.
