# Verification Gates 4 and 5 — Upload completion (SI-03.10)

**Date:** 2026-11-12 · **Refs:** phase-03-videos/TD-02 (revision IC-1), TD-05, TD-09 · **Result:** Gate 5 PASS (approved by the user 2026-11-12) · Gate 4 PENDING — safety fix of 2026-11-12 applied and re-tested, awaiting re-review

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
| Object with declared size but another `upload-binding` | `upload_binding_token` changed in the DB | refused: `failed`/`UPLOAD_INVALID`, no job, `DeleteObject` **not** called, object still present with the same ETag; a repeated complete stays refused (revision 2026-11-12) |
| Complete timeout / reset | `drop-after-forward` | `completing`, `failure_reason` null — never `uploading` nor `failed` |
| Storage unreachable before the claim | real client pointed at a closed local port | `STORAGE_UNAVAILABLE` (503); row `uploading` |

### Final ETag determinism (pinned MinIO)

`HeadObject(videos/<id>/original).ETag` **equals** `md5(concat(binary part MD5s)) + "-3"` computed from the verified manifest (test "records whether the final ETag is deterministic…"). `FINAL_ETAG_IS_DETERMINISTIC = true` in `src/videos/completion-proof.ts` is therefore backed by evidence. It is used only as an **additional** check. The ETag is never treated as a content checksum (TD-02).

## Finding fixed during the gate

The AWS SDK v3 does not surface an HTTP 200 with an `<Error>` body as status 200. It re-throws it as `$metadata.httpStatusCode = 503`, `$fault = 'server'`, and keeps the code (probe run against the proxy). Before the fix, the classifier fell back on the status and treated `InvalidPart` as **ambiguous**, so the row stayed `completing` instead of being released. `classifyStorageError` now checks an explicit set of definitive S3 codes (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, …) before any status rule, as SI-03.4/TD-02 require ("by code, never by status alone"). This is covered by `src/storage/storage-errors.spec.ts`.

## Not covered here

- The HTTP mapping (`200`/`202` + `Retry-After: 60`, `409`) belongs to SI-03.11 (E2E).
- The release of an open, objectless claim (`allowRelease`) is exercised at service level in `upload-recovery.service.integration-spec.ts`. Since SI-03.11 the retried complete also uses it (TD-02 step 7) and re-runs the protocol; E2E 3.3 covers that. The reconciler schedule belongs to SI-03.15.

## Revision 2026-11-12 — Gate 4 safety fix (human review)

**Review decision:** Gate 4 stays PENDING. An object at the key whose `upload-binding` differs from `upload_binding_token` must:

- refuse the completion and record `UPLOAD_INVALID`;
- publish no job and grant no access;
- **not** be deleted automatically, since its identity/authorization was not proven;
- be preserved as evidence for investigation and a later safe cleanup.

**Change:**

- `contradictionOf()` (`src/videos/completion-proof.ts`) reports which element contradicts the proof. The binding is checked first.
- `UploadRecoveryService.markInvalid` deletes only when identity **is** proven: own binding with the wrong size or ETag, the TD-02 failure matrix and TD-09 "object deleted" rows.
- For `binding`, it keeps the object and writes a structured `upload_invalid_object_retained` warning: video id, key, observed size and ETag, no token and no URL.
- A `failed` video is never deliverable: delivery requires `ready` (SI-03.16).

**Re-run:** `docker compose exec -T nestjs-api npx jest --selectProjects unit integration --testPathPatterns 'completion-proof|video-completion|upload-recovery' --verbose` → **29 passed**. The relevant cases:

| Test | Observed |
|---|---|
| `video-completion` — another binding (via `complete`) | `failed`/`UPLOAD_INVALID`, 0 jobs, `deleteObject` spy **not called**, object present with the same ETag; repeated `complete` → 409, still not deleted, 0 jobs |
| `upload-recovery` — another binding (via `resolve`) | `failed`/`UPLOAD_INVALID`, 0 jobs, `deleteObject` not called, object present |
| `upload-recovery` — this binding, wrong size | `failed`/`UPLOAD_INVALID`, object deleted (identity proven) |
| `completion-proof` unit | binding reported first even when size/ETag also differ; size/ETag only with this binding |

**Governed document out of sync (not edited by hand):** the plan's Error Catalog row `UPLOAD_INVALID` (`phase-03-videos.md`) still says "the object is deleted" for both causes. The TDs only prescribe deletion for a size contradiction, which is still honored. The catalog row needs syncing through the formal procedure, e.g. `/decide` with an Append revision to TD-02 and `/plan-build` append-mode.

**Follow-up for SI-03.15 (reaper):** the reaper must not delete originals of `failed`/`UPLOAD_INVALID` videos whose object was retained for a binding contradiction.
