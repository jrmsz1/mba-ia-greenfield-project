# Verification Gates 7 and 8 — Presigned delivery (SI-03.16)

**Date:** 2026-11-12 · **Refs:** phase-03-videos/TD-11 (incl. revision IC-2), TD-04, TD-12, TD-13, TD-15 · **Result:** evidence executed for every scenario — **both gates PENDING, awaiting human review**

## What was built

- **`VideoDeliveryService`** (`src/videos/video-delivery.service.ts`) handles owner-only, `ready`-only emission:
  - Playback uses `PLAYBACK_PRESIGN_TTL_SECONDS` (3600) and download uses `DOWNLOAD_PRESIGN_TTL_SECONDS` (900).
  - Download adds `ResponseContentDisposition: attachment` with an RFC 6266/5987-encoded `original_filename`.
  - Both URLs are signed for the **public** endpoint. One slot of the shared 60-per-hour window (`delivery_urls_issued`) is reserved atomically **before** signing.
  - Nothing is logged or persisted except the counter.
- **Routes** `GET /videos/:id/playback-url` and `GET /videos/:id/download-url` (`VideosController`), with `Cache-Control: no-store`, the body `{ url, expires_at }`, and the owner check of `VideoAccessPolicy` (404 for any other channel). `openapi.json` was regenerated: each route documents 200/401/404/409/429.

## Evidence

| Suite | Command (from `nestjs-project/`) | Result |
|---|---|---|
| Storage-level, real pinned MinIO, plain HTTP | `docker compose exec -T nestjs-api npx jest --selectProjects integration --testPathPatterns video-delivery --verbose` | 9 passed |
| Unit | `docker compose exec -T nestjs-api npx jest --selectProjects unit --testPathPatterns video-delivery` | 10 passed |
| E2E (spec `videos-delivery-urls.plan.md` + negatives) | `docker compose exec -T nestjs-api npx jest --config test/jest-e2e.json --testPathPatterns videos-delivery-urls --verbose` | 8 passed |

### Gate 8 — HTTP Range directly on MinIO (URLs emitted by the API, real Compose infrastructure)

| Check | Observed |
|---|---|
| `Range: bytes=0-1023` | **206**, `Content-Range: bytes 0-1023/<size>`, `Content-Length: 1024`, `Accept-Ranges: bytes`, bytes identical to the source (SHA-256) |
| Mid-file and open-ended ranges (seek) | 206, matching bytes; `Content-Range: bytes <size-10>-<size-1>/<size>` |
| Unsatisfiable range (`bytes=<size+10>-`) | **416** (`Content-Range` deliberately not asserted, as TD-11 notes for the pinned build) |
| Syntactically invalid range (`bytes=abc`) | 200 with the whole object (permitted by RFC 9110) |
| Unsigned request / tampered `X-Amz-Signature` | **403** / **403** |
| E2E 1.2 (through the API) | 206 + `Content-Range`, 416, 403 for unsigned |

### Gate 7 — Presigned URL expiry and renewal

| Check | Observed |
|---|---|
| TTL per kind | `X-Amz-Expires` = 3600 on playback, 900 on download (configured defaults) |
| Expiry (test-only override `PLAYBACK_PRESIGN_TTL_SECONDS=2`) | 206 before `expires_at`; **403** with the same URL after it (AccessDenied) |
| Renewal resumes the position | a new URL (different from the first) answers **206** with `Content-Range: bytes 1024-2047/<size>` and the exact bytes |
| Authorization unchanged by renewal | after the owner renews twice, another user still gets 404 |
| E2E 1.3 (through the API) | same: 206 → 403 → renewed 206 at the same byte |

### Download, access control, abuse limit, credentials

| Check | Observed |
|---|---|
| Content-Disposition | the storage answers `attachment; filename="Meu v_deo.mp4"; filename*=UTF-8''Meu%20v%C3%ADdeo.mp4` |
| Not ready (`processing`; unit: also uploading, completing, uploaded, failed) | 409 `VIDEO_NOT_READY` on both routes, before reserving or signing |
| Another user / unknown id / no token | 404 `VIDEO_NOT_FOUND` (no URL in the body) / 404 / 401 |
| 61st URL in one hour (alternating playback/download) | 429 `DELIVERY_URL_LIMIT_EXCEEDED`; after the window is moved back 61 min, 200 |
| Logs | after every E2E test, no captured log line contains `X-Amz-` or `Signature=` |
| `S3_SECRET_ACCESS_KEY` | never in the URL nor in the response body |
| `S3_ACCESS_KEY_ID` | present **only** inside `X-Amz-Credential` — see the incompatibility below |

## Incompatibility awaiting a decision (SI-03.16 AC #1)

AC #1 requires that the body contains neither `S3_SECRET_ACCESS_KEY` **nor `S3_ACCESS_KEY_ID`**. A SigV4 presigned URL always carries the signer's access key **ID** in `X-Amz-Credential=<ACCESS_KEY_ID>/<date>/<region>/s3/aws4_request`. This was confirmed on the emitted URLs.

The ID is an identifier, not a secret, and TD-11 only forbids *permanent credentials* in the response. With the current design, though (TD-04: one credential pair; TD-16: one `S3_ACCESS_KEY_ID`), the literal AC cannot hold. Options, not applied:

- (a) restate AC #1 as "no secret key; the access key ID appears only inside `X-Amz-Credential`", the behavior currently implemented and tested;
- (b) sign delivery URLs with a separate, read-only credential pair (new environment keys, a TD-04/TD-16 revision);
- (c) sign with temporary STS credentials from MinIO (an architecture change).

## Notes

- The E2E stores random bytes, not a media fixture. Delivery never inspects content, real-media validity is Gate 6, and the API container has no FFmpeg (TD-06).
- `expires_at` is computed from the issue instant and the TTL. SigV4 counts from `X-Amz-Date` (second resolution), so the expiry test waits `expires_at` + 1.5 s.
