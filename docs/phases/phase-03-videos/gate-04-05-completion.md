# Verification Gates 4 and 5 — Upload completion (SI-03.10)

**Date:** 2026-11-12 · **Refs:** phase-03-videos/TD-02 (revision IC-1), TD-05, TD-09 · **Result:** evidence executed for every scenario (see below); awaiting human approval

## Setup

- `nestjs-project/src/videos/video-completion.service.integration-spec.ts` runs against the **pinned MinIO** (`RELEASE.2025-09-07T16-13-09Z`, Gate 2) and the test PostgreSQL. It uses the test bucket and the test pg-boss schema only.
- Faults come from `src/test/s3-fault-proxy.ts`, a real HTTP proxy in front of MinIO. Only the `singleAttempt` client (CompleteMultipartUpload) goes through it; ListParts, HeadObject and UploadPart go straight to MinIO. The proxy forwards with the same `Host` header, so the SigV4 signatures stay valid.
- Parts are real uploads of 5 MiB + 5 MiB + 2 MiB (12 MiB declared) via `UploadPartCommand`.

## Evidence

Command (from `nestjs-project/`): `docker compose exec -T nestjs-api npx jest --selectProjects integration --testPathPatterns 'video-completion|upload-recovery'` → **16 passed**.

| Scenario (SI-03.10 AC) | Fault / input | Observed |
|---|---|---|
| Verified manifest | none | `uploaded`; exactly 1 `video.process` job, `data = { videoId }` |
| ETag of one part swapped | manifest etag replaced | `UPLOAD_PARTS_MISMATCH`; `completeMultipartUpload` never called; row `uploading` |
| **Gate 5** — 5 concurrent completes | `Promise.allSettled` × 5 | all fulfilled (`done`/`pending`, no error); one transition to `uploaded`; 1 job |
| **Gate 4** — lost Complete response | `drop-after-forward` (MinIO completes, client socket destroyed) | first call `pending`/`completing`, 0 jobs; repeated call proves the object (key, `upload_id` gone, size, `upload-binding`) → `uploaded`, 1 job |
| **Gate 4** — reordered manifest | parts 2,1,3 | `VALIDATION_ERROR` before any storage call or claim |
| **Gate 4** — part replaced after its ETag was recorded | re-upload part 2 with new bytes | `UPLOAD_PARTS_MISMATCH`; row `uploading` |
| **Gate 4** — 200 + `<Error>InternalError` | `error-200-no-forward:InternalError` | `pending`/`completing` (→ 202 in SI-03.11) |
| **Gate 4** — 200 + `<Error>InvalidPart` | `error-200-no-forward:InvalidPart` | claim released → `uploading`; `UPLOAD_PARTS_MISMATCH` (409) |
| HeadObject unavailable during the proof | `StorageUnavailableError(ambiguous)` from `headObject` | stays `completing` |
| Object with declared size but another `upload-binding` | `upload_binding_token` changed in the DB | `failed`/`UPLOAD_INVALID`; object deleted (`HeadObject` → 404) |
| Complete timeout / reset | `drop-after-forward` | `completing`, `failure_reason` null — never `uploading` nor `failed` |
| Storage unreachable before the claim | real client pointed at a closed local port | `STORAGE_UNAVAILABLE` (503); row `uploading` |

### Final ETag determinism (pinned MinIO)

`HeadObject(videos/<id>/original).ETag` **equals** `md5(concat(binary part MD5s)) + "-3"` computed from the verified manifest (test "records whether the final ETag is deterministic…"). `FINAL_ETAG_IS_DETERMINISTIC = true` in `src/videos/completion-proof.ts` is therefore backed by evidence. It is used only as an **additional** check. The ETag is never treated as a content checksum (TD-02).

## Finding fixed during the gate

The AWS SDK v3 does not surface an HTTP 200 with an `<Error>` body as status 200. It re-throws it as `$metadata.httpStatusCode = 503`, `$fault = 'server'`, and keeps the code (probe run against the proxy). Before the fix, the classifier fell back on the status and treated `InvalidPart` as **ambiguous**, so the row stayed `completing` instead of being released. `classifyStorageError` now checks an explicit set of definitive S3 codes (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, …) before any status rule, as SI-03.4/TD-02 require ("by code, never by status alone"). This is covered by `src/storage/storage-errors.spec.ts`.

## Not covered here

- The HTTP mapping (`200`/`202` + `Retry-After: 60`, `409`) belongs to SI-03.11 (E2E).
- The reconciler path for stale claims (`allowRelease`) is exercised at service level in `upload-recovery.service.integration-spec.ts`. Its scheduling belongs to SI-03.15.
