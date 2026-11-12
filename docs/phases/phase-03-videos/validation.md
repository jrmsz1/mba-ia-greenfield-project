---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-12T18:55:32-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-12T18:55:32-03:00"
issues:
  - id: AMB-1
    status: resolved
    resolved_by: clarification
    summary: "Draft pre-registration vs Phase 04 publication/visibility boundary"
  - id: OQ-1
    status: resolved
    resolved_by: phase-03-videos/TD-01
    summary: "TD-01 pending — Large-file upload protocol and transport"
  - id: OQ-2
    status: resolved
    resolved_by: phase-03-videos/TD-02
    summary: "TD-02 pending — Upload resumability, completion and cross-system consistency"
  - id: OQ-3
    status: resolved
    resolved_by: phase-03-videos/TD-03
    summary: "TD-03 pending — S3-compatible object storage server (MinIO)"
  - id: OQ-4
    status: resolved
    resolved_by: phase-03-videos/TD-04
    summary: "TD-04 pending — S3 client library and endpoint/signing model"
  - id: OQ-5
    status: resolved
    resolved_by: phase-03-videos/TD-05
    summary: "TD-05 pending — Background job queue and job-loss prevention"
  - id: OQ-6
    status: resolved
    resolved_by: phase-03-videos/TD-06
    summary: "TD-06 pending — Media worker topology and responsibilities"
  - id: OQ-7
    status: resolved
    resolved_by: phase-03-videos/TD-07
    summary: "TD-07 pending — FFmpeg/ffprobe toolchain, validity rules and resource limits"
  - id: OQ-8
    status: resolved
    resolved_by: phase-03-videos/TD-08
    summary: "TD-08 pending — Processing input access and scratch storage"
  - id: OQ-9
    status: resolved
    resolved_by: phase-03-videos/TD-09
    summary: "TD-09 pending — Video lifecycle state machine and failure handling"
  - id: OQ-10
    status: resolved
    resolved_by: phase-03-videos/TD-10
    summary: "TD-10 pending — Unique public video identifier and storage keys"
  - id: OQ-11
    status: resolved
    resolved_by: phase-03-videos/TD-11
    summary: "TD-11 pending — HTTP streaming and download delivery"
  - id: OQ-12
    status: resolved
    resolved_by: phase-03-videos/TD-12
    summary: "TD-12 pending — Authorization, ownership by channel and channel isolation"
  - id: OQ-13
    status: resolved
    resolved_by: phase-03-videos/TD-13
    summary: "TD-13 pending — Upload validation, abuse controls and untrusted-file handling"
  - id: OQ-14
    status: resolved
    resolved_by: phase-03-videos/TD-14
    summary: "TD-14 pending — Orphan resource cleanup and reconciliation"
  - id: OQ-15
    status: resolved
    resolved_by: phase-03-videos/TD-15
    summary: "TD-15 pending — Test strategy for storage, queue, worker and the API contract"
  - id: OQ-16
    status: resolved
    resolved_by: phase-03-videos/TD-16
    summary: "TD-16 pending — Docker Compose topology and environment contract"
  - id: IC-1
    status: resolved
    resolved_by: phase-03-videos/TD-09, phase-03-videos/TD-02
    summary: "TD-09 transition table lacks uploading → uploaded required by TD-02 matrix"
  - id: IC-2
    status: resolved
    resolved_by: phase-03-videos/TD-16, phase-03-videos/TD-11, phase-03-videos/TD-13, phase-03-videos/TD-14
    summary: "TD-16 canonical env keys omit TTL and threshold keys used by TD-11/TD-14"
  - id: ICC-1
    status: resolved
    resolved_by: phase-03-videos/TD-13, phase-02-auth/TD-08
    summary: "TD-13 throttles video endpoints; phase-02-auth/TD-08 is AuthModule-only"
  - id: AMB-2
    status: resolved
    resolved_by: phase-03-videos/TD-13, phase-03-videos/TD-14, phase-03-videos/TD-16
    summary: "TD-13 per-owner quota metric undecided; limit defaults deferred to planning"
  - id: AMB-3
    status: resolved
    resolved_by: phase-03-videos/TD-08, phase-03-videos/TD-16
    summary: "Worker input presigned URL has no TTL key; TD-08 needs TTL > job timeout"
  - id: IC-3
    status: resolved
    resolved_by: phase-03-videos/TD-09, phase-03-videos/TD-02
    summary: "TD-09 ties UPLOAD_INVALID to object deletion; TD-02 rev retains foreign object"
  - id: IC-4
    status: resolved
    resolved_by: phase-03-videos/TD-15, phase-03-videos/TD-16
    summary: "TD-15 test bucket reset vs TD-04/TD-16 bucket-scoped identities, no root"
  - id: IC-5
    status: resolved
    resolved_by: phase-03-videos/TD-16, phase-03-videos/TD-15
    summary: "TD-15 test-only operational identities have no TD-16 keys nor delivery path"
  - id: AMB-4
    status: resolved
    resolved_by: phase-03-videos/TD-15
    summary: "External test-maintenance cleanup vs in-container suites: runner and ordering"
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **AMB-1** _(resolved_by clarification)_ — Draft pre-registration vs Phase 04 publication/visibility boundary. Clarified on 2026-11-11: Phase 03 only creates the draft and keeps the `publication` state; the draft → publication transition, visibility and editing belong to Phase 04. No TD edit and no project-plan.md edit.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 decided: option A — Large-file upload protocol and transport.
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 decided: option A — Upload resumability, completion and cross-system consistency.
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 decided: option A — S3-compatible object storage server (MinIO).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 decided: option A — S3 client library and endpoint/signing model.
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 decided: option A — Background job queue and job-loss prevention.
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 decided: option A — Media worker topology and responsibilities.
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 decided: option A — FFmpeg/ffprobe toolchain, validity rules and resource limits.
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 decided: option A — Processing input access and scratch storage.
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 decided: option A — Video lifecycle state machine and failure handling.
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 decided: option A — Unique public video identifier and storage keys.
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 decided: option A — HTTP streaming and download delivery.
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — TD-12 decided: option A — Authorization, ownership by channel and channel isolation.
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — TD-13 decided: option A — Upload validation, abuse controls and untrusted-file handling.
- **OQ-14** _(resolved_by phase-03-videos/TD-14)_ — TD-14 decided: option A — Orphan resource cleanup and reconciliation.
- **OQ-15** _(resolved_by phase-03-videos/TD-15)_ — TD-15 decided: option A — Test strategy for storage, queue, worker and the API contract.
- **OQ-16** _(resolved_by phase-03-videos/TD-16)_ — TD-16 decided: option A — Docker Compose topology and environment contract.
- **IC-1** _(resolved_by phase-03-videos/TD-09, phase-03-videos/TD-02)_ — TD-09 transition table lacks uploading → uploaded required by TD-02 matrix. Append revision to TD-09 (transitions `uploading` → `uploaded` with identity proof, `uploading`/`completing` → `failed` `UPLOAD_LOST` and → `expired`; no transition on timeout/reset/5xx) and to TD-02 (identity and integrity proof replaces the size-only check). Decisions unchanged (A).
- **IC-2** _(resolved_by phase-03-videos/TD-16, phase-03-videos/TD-11, phase-03-videos/TD-13, phase-03-videos/TD-14)_ — TD-16 canonical env keys omit TTL and threshold keys used by TD-11/TD-14. Append revisions to TD-16 (complete key list: three TTL keys replacing `PRESIGN_TTL_SECONDS`, `COMPLETING_STALE_MINUTES`, named worker/media/quota/test keys without invented defaults), TD-11 (playback/download TTL keys), TD-13 (part URL TTL key) and TD-14 (threshold keys). Decisions unchanged (A).
- **ICC-1** _(resolved_by phase-03-videos/TD-13, phase-02-auth/TD-08)_ — TD-13 throttles video endpoints; phase-02-auth/TD-08 is AuthModule-only. Code check: `ThrottlerGuard` is a global `APP_GUARD` with one unnamed policy `{ ttl: 60000, limit: 10 }`. Append revision to TD-13 (Phase 03 video controllers opt out with `@SkipThrottle()`; abuse control by per-owner quotas, simultaneous-upload limit, ownership, idempotency, size and expiry) and a documentary revision to phase-02-auth/TD-08 (actual registration scope). Auth limits unchanged.
- **AMB-2** _(resolved_by phase-03-videos/TD-13, phase-03-videos/TD-14, phase-03-videos/TD-16)_ — TD-13 per-owner quota metric undecided; limit defaults deferred to planning. Append revision to TD-13 (quota = pending bytes, sum of declared sizes of the owner's `uploading`/`completing` uploads, key `MAX_PENDING_UPLOAD_BYTES_PER_OWNER`), TD-16 (key added; initial values of the seven limit keys set by `plan-build` as configurable defaults tested with small overrides) and TD-14 (`COMPLETING_STALE_MINUTES` default set by `plan-build`). Decisions unchanged (A).
- **AMB-3** _(resolved_by phase-03-videos/TD-08, phase-03-videos/TD-16)_ — Worker input presigned URL has no TTL key; TD-08 needs TTL > job timeout. Append revision to TD-08 (worker input URL uses `PROCESSING_INPUT_PRESIGN_TTL_SECONDS`, default set by `plan-build`, startup validation rejects a value not greater than `WORKER_JOB_TIMEOUT_SECONDS`) and to TD-16 (key added to the canonical list). Decisions unchanged (A).
- **IC-3** _(resolved_by phase-03-videos/TD-09, phase-03-videos/TD-02)_ — TD-09 ties UPLOAD_INVALID to object deletion; TD-02 rev retains foreign object. Append revision to TD-09 (2026-11-12): `uploading`/`completing` → `failed` (`UPLOAD_INVALID`) on an upload-binding contradiction with the object retained, no job, never delivered; "object deleted" kept only for an object that carries this upload's binding with a size/ETag contradiction, after a re-read before the delete. Decision unchanged (A).
- **IC-4** _(resolved_by phase-03-videos/TD-15, phase-03-videos/TD-16)_ — TD-15 test bucket reset vs TD-04/TD-16 bucket-scoped identities, no root. Append revision to TD-15 (2026-11-12): provisioning also creates and validates `S3_TEST_BUCKET`; tests use the TD-04 permission profiles instantiated as test-only identities scoped to `S3_TEST_BUCKET`; fixture preparation and destructive cleanup run outside API and worker under a test-maintenance identity restricted to `S3_TEST_BUCKET`, after the target is positively verified (fail-closed); negative-permission tests never use the maintenance identity; no root credential to API or worker. Append revision to TD-16 (2026-11-12): optional `S3_TEST_MAINTENANCE_ACCESS_KEY_ID`/`S3_TEST_MAINTENANCE_SECRET_ACCESS_KEY`, separate from root and every other identity, collisions rejected by provisioning/preflight, never injected into operational API/worker containers nor used as a fallback. Decisions unchanged (A).
- **IC-5** _(resolved_by phase-03-videos/TD-16, phase-03-videos/TD-15)_ — TD-15 test-only operational identities have no TD-16 keys nor delivery path. Option (a): Append revision to TD-16 (2026-11-12) naming `S3_TEST_API_*`, `S3_TEST_WORKER_*`, `S3_TEST_DELIVERY_*` for the TD-04 profiles scoped to `S3_TEST_BUCKET`. They may be passed to `nestjs-api`/`worker` for in-container test runs and are mapped onto the per-process clients only in the explicit test context, never as a production fallback. Provisioning/preflight rejects collisions with root, production and maintenance identities. Decision unchanged (A).
- **AMB-4** _(resolved_by phase-03-videos/TD-15)_ — External test-maintenance cleanup vs in-container suites: runner and ordering. Option (a): Append revision to TD-15 (2026-11-12). Fixture preparation and destructive cleanup run in an ephemeral on-demand test-maintenance container (not a Compose service, not `nestjs-api`/`worker`), before and/or after the suite runs, never concurrently, with fail-closed target verification. The in-container suites perform no storage cleanup and only verify the test-bucket target; tests isolate objects by unique keys. Test DB and queue-schema resets are unchanged. Decision unchanged (A).
