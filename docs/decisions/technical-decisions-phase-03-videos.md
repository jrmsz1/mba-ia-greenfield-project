---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-11-11
scope_description: "Video upload and processing foundation (Phase 03, backend only): S3-compatible object storage (historical MinIO build, pinned and checksum-verified), 10 GB multipart upload with per-part presigned URLs and resumability, consistency between PostgreSQL, storage and the job queue, a dedicated FFmpeg/ffprobe worker, the video state machine, a unique public video identifier, Range-capable streaming and download, authorization and abuse controls, orphan cleanup, the Docker Compose topology and the test strategy. The Next.js UI is out of scope."
---

# Technical Decisions — Phase 03: Video Upload and Processing

_Subprojects in scope:_

- `nestjs-project/` — the only subproject with implementation in this phase. Owns the upload orchestration API, the storage/queue integrations, the media worker (a second entrypoint of the same codebase, TD-06), the Docker Compose services added to `nestjs-project/compose.yaml`, the migrations/entities for videos, and the integration/e2e tests of all of the above (which must run without any frontend).
- `next-frontend/` — **no open decision and no implementation in Phase 03** (explicit scope exclusion of the architecture review of 2026-11-11: the Next.js interface does not belong to this phase). The upload/streaming handshake is specified here as a plain HTTP API contract; a future client reaches it through the BFF (`next-frontend-config-base/TD-03`). No Frontend-scoped TD is opened.

> Cross-doc anchors (already decided — do NOT reopen):
> - **Strict BFF, single server-only `API_URL`:** `next-frontend-config-base/TD-03`. Binding for the future client only: the browser never calls the NestJS API and holds no JWT (`phase-02-auth-frontend/TD-01`, `TD-02`). The API contract below must be consumable as plain HTTP calls through a BFF.
> - **Backend auth and errors:** `phase-02-auth/TD-02` (custom guards; `JwtAuthGuard` and `ThrottlerGuard` are global `APP_GUARD`s, `@Public()` opts out), `TD-07` (domain exceptions → `{ statusCode, error, message }`), `TD-08` (`@nestjs/throttler`, in-memory).
> - **Configuration:** `phase-01-configuracao-base/TD-01..TD-04` (`@nestjs/config`, Joi env validation, namespaced `registerAs`). Every new key must appear in the Joi schema, `compose.yaml` and `.env.example` (TD-16).
> - **Contract chain:** `openapi-docs-nestjs/TD-01..TD-03` and `next-frontend-openapi-typing/TD-01..TD-05` — new endpoints extend the OpenAPI artifact; no new contract-sync TD is needed.
> - **Test baseline (repo state, not a TD):** integration/e2e run against `streamtube_test` behind explicit guards, serialized (`maxWorkers: 1`), always inside the container. New stateful services must follow the same isolation rule (TD-15).

> **Review rounds of 2026-11-11.** Round 1 (research brief) fixed the scope (backend only; the Next.js UI is excluded) and the MinIO direction. Round 2 (architecture review, this version) approved the set below and required three adjustments — TD-02 (multipart and consistency), TD-05 (`pg-boss` validation conditions) and TD-11 (presigned delivery) — all applied here.
> - **Approved conceptually (round 2):** TD-01, TD-03, TD-04, TD-05 (conditional on the spike), TD-06, TD-07, TD-08, TD-09, TD-10, TD-12, TD-13, TD-14, TD-15, TD-16; TD-02 and TD-11 approved with the adjustments written into their text. **Formalization stays in `/plan-resolve`: every `**Decision:**` field remains `_[pending]_`; "approved" never means "decided".**
> - **Human decisions recorded in round 2:** (1) maximum upload **10 GiB = 10,737,418,240 bytes**, configurable (TD-01, TD-13); (2) accepted media for this phase: **MP4 with H.264 video and optional AAC audio** — anything else is rejected as unsupported, no transcoding is promised, and the file extension is never proof of compatibility (TD-07); (3) **download only by the authenticated owner** until publication/visibility exist in later phases (TD-11, TD-12); (4) **aborting an incomplete upload is supported**; cancelling a processing already started is not required (TD-09); (5) the MinIO image is to be built reproducibly from the pinned official binary with the SHA-256 verified during the build, keeping the no-maintenance warning and limiting use to local/academic environments (TD-03); (6) FFmpeg logs and persisted errors must carry **no credentials and no signature parameters, and never a presigned URL** (TD-07, TD-13).
> - **Format note:** besides the fields required by the research skill, each TD carries three extra paragraphs requested by the architecture brief — `Trade-offs and risks`, `Implementation impact`, `References` — placed between `Recommendation` and `Decision`. Pipeline readers ignore them (they extract `Recommendation`/`Libraries` only).
> - **Evidence gathered** (all in disposable containers/directories outside the repository, 2026-11-11):
>   - **E1 — MinIO distribution and integrity.** `dl.min.io` answers **HTTP 410 Gone** for the community listing, the candidate binary and its `.sha256sum` ("These files are no longer served from this site"). The same release is attached to the **GitHub release** `RELEASE.2025-09-07T16-13-09Z` (published 2025-09-07): `minio.linux-amd64.RELEASE.2025-09-07T16-13-09Z` (110,989,496 bytes) plus `.sha256sum`, `.shasum`, `.minisig`, `.asc`. Downloaded to an isolated directory: size equals the published asset size; SHA-256 `7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f` **equals** the published checksum; the file is a statically linked ELF x86-64. The binary starts in a `debian:12-slim` container (`Version: RELEASE.2025-09-07T16-13-09Z (go1.24.6 linux/amd64)`, `License: GNU AGPLv3`), `/minio/health/live` and `/minio/health/ready` return 200, and data survives a container restart on a named volume. No image of this tag exists on Docker Hub, Quay or GHCR.
>   - **E2 — S3 behavior of that build** (AWS SDK `@aws-sdk/client-s3` 3.1167.0 / `s3-request-presigner` 3.1166.0): per-part presigned `PUT` from the "public" host works; part `ETag` equals the MD5 of the part and the final object `ETag` is composite (`…-3`); `ListParts` paginates; repeated/concurrent `Complete` yields one success and `NoSuchUpload` for the rest; `Complete` accepts a **missing part**; ranged `GET` answers `206`; details in the TDs.
>   - **E3 — Media tooling:** Debian 12 FFmpeg/ffprobe **5.1.9** reading objects over HTTP (presigned GET), including a 359 MiB file with the `moov` atom at the end.
>   - **E4 — Documentation read:** AWS S3 API/userguide pages (including the multipart overview and the multipart-ETag statement), RFC 9110 §14/§15, FFmpeg protocol/format/ffprobe pages, NestJS and Express docs (Context7), pg-boss/BullMQ/tus/AWS SDK docs (Context7), project READMEs/compatibility matrices of the alternative servers.
>   - **E5 — Container/codec signals exposed by ffprobe 5.1.9** on ten generated fixtures: MP4, MOV and 3GP share `format_name` `mov,mp4,m4a,3gp,3g2,mj2` and differ only by `major_brand` (`isom`, `qt  `, `3gp6`); Matroska/WebM report `matroska,webm`, so an MKV saved as `.mp4` is detected; video codec (`h264`, `hevc`, `vp9`), pixel format (`yuv420p`, `yuv444p`) and audio codec (`aac`, `mp3`, none) are all visible.
> - **Documented but not exercised (hypotheses taken from documentation):** pinning part size by signing `Content-Length`; S3 additional checksums (CRC/SHA) for whole-object integrity; the SDK `Range` parameter on `GetObject`; `response-content-disposition` on servers other than the pinned MinIO; behavior of the alternative S3 servers; MP4 brands other than `isom`; browser behavior of a media element after its presigned URL expires.
> - **Future validations (conditions for the planning/implementation stage — none of them is completed):** (1) **TypeORM + `pg-boss` transactional integration** — same-transaction enqueue, rollback, commit and durable recovery (mandatory planning condition, TD-05); (2) **reproducible build of the MinIO Docker image** with the SHA-256 verified during the build, and a Compose run with health check and CORS (TD-03, TD-16), plus the minisign signature check and the arm64 asset checksum; (3) **upload tests up to 10 GiB** and the processing of such an object (TD-01, TD-08, TD-13); (4) **identity and integrity of the object after an ambiguous completion** — beyond the `HeadObject` size, that the object found belongs to this upload (TD-02); (5) **two concurrent completions of the same video at the application level** — the claim and its losers (storage-level concurrency was verified in E2; TD-02); (6) **real fixtures** for MP4 container identification (brand allowlist), H.264 and optional AAC (TD-07, TD-15); (7) **expiry and renewal of presigned URLs** during prolonged playback (TD-11); (8) **HTTP Range streaming directly from MinIO** through the URLs emitted by the API, in the Compose environment (storage-level behavior was verified in E2; TD-11).
> - **Versions actually researched:** MinIO `RELEASE.2025-09-07T16-13-09Z`; AWS SDK v3 3.1166.0–3.1167.0 (client-s3 registry latest on 2026-11-11: 3.1166.0; Node ≥ 20, and the SDK warns that releases after the first week of January 2027 require Node ≥ 22); `pg-boss` 12.38.2 (Node ≥ 22.12, PostgreSQL ≥ 13, `pg ^8.23.1`); `bullmq` 6.7.4 and `@nestjs/bullmq` 12.0.1 (peers accept `@nestjs/core ^11`); `@tus/server` 2.4.7 / `@tus/s3-store` 2.1.0; `nanoid` 6.0.2 (ESM-only, `engines` `^22 || ^24 || >=26`) and 3.3.20 (CJS); `sqids` 0.3.0 (CJS support unverified); `fluent-ffmpeg` 2.1.3 (deprecated); FFmpeg 5.1.9 (Debian 12). Installed in the repo: NestJS 11.1.16, Express 5.2.1, TypeORM 0.3.28, `pg` 8.20.0, Node 25.6.0 in the containers.

---

## TD-01: Large-file upload protocol and transport

**Scope:** Backend

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"; "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** *Problem:* upload files of up to 10 GB without blocking or loading the API, resumable after a connection drop, with the draft video created at the start. *Requirements:* the file must not cross NestJS or Next.js; server-side limit under the convention **10 GB = 10 GiB = 10,737,418,240 bytes** (human decision of the architecture review, configurable through `MAX_UPLOAD_BYTES`); expiring URLs; part-size limits; `ListParts` pagination; integrity; per-user/channel authorization; CORS and `ETag` readable by a browser client; testable with plain HTTP clients (no frontend). *Constraints:* S3 multipart limits (AWS): parts 5 MiB–5 GiB, at most 10,000 parts, `ListParts` pages of 1,000, a single `PUT` capped at 5 GB (so a single presigned PUT is excluded). Conceptual flow: (1) authenticated client asks to start; (2) API authorizes and creates the draft video; (3) API starts the multipart upload; (4) API returns upload data and presigned part URLs; (5) client `PUT`s parts straight to storage; (6) client asks the API to complete; (7) API validates and completes the object; (8) the video enters the asynchronous processing flow. Verified on the pinned MinIO build (E2): steps 3–7 work end to end with plain `fetch` calls.

**Options:**

### Option A: Browser/client → object storage, multipart with per-part presigned URLs (API orchestrates)
- The API creates the draft and the multipart upload and mints presigned `UploadPart` URLs in batches; the client slices the file, `PUT`s each part, keeps each part's `ETag`, and calls `complete`. Only small JSON calls reach the API.
- **Pros:** file bytes never touch NestJS or Next.js; native resume; no frontend needed to test (any HTTP client can `PUT`); on the pinned build the per-part ETag equals the part's MD5 (usable for integrity; the whole-object ETag is composite, never a file hash — TD-02) and abort revokes in-flight part URLs (E2).
- **Cons:** client-side logic (slicing, retries, parallelism); the storage endpoint must be reachable by the client and signed for that host (TD-04); the storage layer does not enforce part sizes, so the API must verify them (TD-02, TD-13); CORS is server-level on this MinIO build (TD-16).

### Option B: tus resumable-upload protocol (`@tus/server` + `@tus/s3-store`)
- A tus endpoint in the API accepts `PATCH` chunks and writes them to S3 multipart. `@tus/server` 2.4.7 / `@tus/s3-store` 2.1.0 (Node ≥ 20.19) provide `onIncomingRequest` access control, `maxSize` and upload expiration.
- **Pros:** open protocol with built-in resume and expiration; mature client ecosystem.
- **Cons:** every chunk crosses the API (violates "o arquivo não deve atravessar o NestJS"); with a BFF-only client the chunks would also cross Next.js; the default `MemoryLocker` is per process; an additional protocol to test and secure.

### Option C: Streamed `multipart/form-data` POST through the API to storage
- The client posts the whole file; the API pipes it to S3 (e.g., `@aws-sdk/lib-storage` `Upload`).
- **Pros:** simplest client.
- **Cons:** one connection open for hours through the API; no resume after a drop unless chunking is added (which becomes A or B); API CPU/bandwidth consumed by the transfer; contradicts the requirement.

**Recommendation:** Option A (direction approved by the brief) — it is the only option that keeps the transfer off both Node processes, resumes natively, and is verifiable end to end with HTTP clients; its costs (client logic, endpoint reachability, part-size verification) are bounded and testable.

**Trade-offs and risks:** a misbehaving client can upload parts larger than declared — mitigated by verifying `ListParts` sizes before completing (TD-02) and by expiry/abort (TD-14); part URLs are bearer credentials until they expire or the upload is aborted (TTL policy, TD-13); signing `Content-Length` to pin part size via the presigner's `signableHeaders` was not verified against the pinned build; a 10 GiB-scale transfer was not exercised.

**Implementation impact:** API contract of five operations — start (returns video id, upload id, part size, expected part count, expiry), part URLs (batch by part number), status/resume (the parts found in storage with number, size and `ETag`, and the missing numbers), complete (carries the client's ordered manifest of part number + `ETag`, TD-02), abort of an incomplete upload — all owner-scoped (TD-12); default part size 64 MiB (160 parts for 10 GiB; 5 MiB is the S3 minimum and 10,000 parts the maximum, both configurable); presigned URL TTL configurable and re-requestable (SigV4 presign allows up to 7 days; shorter is the default); the start step stores `upload_id`, declared size, part size and expiry on the `videos` row (TD-02); no frontend is needed for tests (TD-15).

**References:** AWS S3 multipart limits https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html; AWS ListParts https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html; AWS presigned URLs https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html; tus Node server https://github.com/tus/tus-node-server (`packages/s3-store/README.md`); empirical results E2.

**Decision:** _[pending]_

---

## TD-02: Upload resumability, completion and cross-system consistency

**Scope:** Backend

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"; "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"; "Serviço de processamento em segundo plano (filas)"

**Context:** *Problem:* define where the upload state lives and how start/complete stay idempotent and safe under concurrency and partial failures. PostgreSQL, the object storage and the queue do **not** share a transaction, so each step must be recoverable. *Requirements (brief):* storage is the source of truth for **which parts exist** (`ListParts`); PostgreSQL is the authority for lifecycle, owner, upload references, processing status and the persistent effects of completion; idempotent start/complete; concurrent complete; expiry; abort of incomplete uploads; `ListParts` pagination; missing parts; recovery across S3/PostgreSQL/queue; validation of the completed object; safe re-publication of the processing event; reconciliation; **no silent fallback to cached state when storage is down**; distinguish transient failure, not found and already completed. *Four artifacts that must not be conflated:* (1) the `ETag`s returned by `UploadPart` and **recorded by the client**; (2) the **verification** of part numbers, sizes and `ETag`s against the paginated `ListParts`; (3) the complete, ordered **manifest** sent to `CompleteMultipartUpload`; (4) the final size verified with `HeadObject`. *What AWS documents (E4):* "For each part upload, you must record the part number and the ETag value"; the listing of in-progress uploads must not be used to build the completion request; the `ListParts` result "doesn't include parts that haven't finished uploading"; and the `ETag` of a multipart object "is not an MD5 digest of the entire object" (it is the MD5 of the concatenated per-part digests with a `-<part count>` suffix). So `ListParts` **verifies** and supports resume, but it does not replace the client-recorded manifest, and the client is not trusted without verification. *Evidence (E2 on the pinned build):* a second `Complete` for the same upload id → `NoSuchUpload` (404), not success; 5 concurrent `Complete` calls → exactly one success, four `NoSuchUpload`; `ListParts` after completion or abort → `NoSuchUpload`; the final `ETag` has the composite form (`…-3`); `Complete` with a wrong ETag → `InvalidPart`, an out-of-order list → `InvalidPartOrder`, a non-last part under 5 MiB → `EntityTooSmall`, and **a list with a missing part is accepted** (a 6 MiB object was created from an 11 MiB upload); `NoSuchUpload` is ambiguous (aborted or completed, per AWS); a `200 OK` can carry an error body for `Complete` (SDKs surface it); abort is idempotent and may need repeating, with `ListParts` empty as proof (AWS).

**Options:**

### Option A: Verified client manifest — storage verifies the parts, PostgreSQL owns business state, compare-and-set transitions
- `videos` stores `upload_id`, declared size, part size, expected part count, `upload_expires_at`, owner/channel and `status`. The client keeps the `ETag` of each part; a client that lost its record rebuilds it from the status operation (`ListParts`-derived: number, size, `ETag`). `complete` receives the client's ordered manifest, verifies it against a fresh paginated `ListParts`, claims the video with a conditional update (`uploading → completing`), calls `CompleteMultipartUpload` with the verified manifest and confirms the object with `HeadObject`. Start is idempotent through a client-supplied key unique per owner.
- **Pros:** follows AWS's record-your-own-parts guidance and the brief's split of authority; no per-part DB writes; resume works from any device; concurrent completes are safe without a distributed transaction; every failure has a recovery path (table below).
- **Cons:** relies on `ListParts` being reliable on the chosen server; one extra state (`completing`) and a reconciler for stale claims (TD-14); the client must store `ETag`s.

### Option B: PostgreSQL tracks each part
- The client reports each part (number, ETag, size) to the API, which records it; resume and completion use the DB.
- **Pros:** independent of `ListParts` quirks; audit trail; the manifest lives on the server.
- **Cons:** a control call and a write per part (160 for 10 GiB at 64 MiB); the DB can drift from storage and then needs the same reconciliation; more endpoints.

### Option C: Client-held state only, stateless server
- **Pros:** smallest server surface.
- **Cons:** the server cannot verify parts, detect missing parts or abandoned uploads; completion would trust client-supplied ETags.

**Recommendation:** Option A (direction approved by the brief, adjusted by the architecture review) — it keeps the client's recorded manifest as the completion input, verifies it against storage before completing, and uses `HeadObject`, conditional transitions and reconciliation — never a timeout — to resolve the ambiguity of a lost `Complete` response; fall back to Option B only if the selected server's `ListParts` fails validation.

**Trade-offs and risks:** a lost response after S3 completed the object leaves the row in `completing` until reconciled (by design: the outcome is unknown); the multipart `ETag` is an opaque version token, **never a content hash of the file** — whole-file integrity in this phase rests on the declared size, the per-part `ETag`s (MD5 of each part on the pinned build) and `ffprobe`; S3 additional checksums (CRC/SHA) are a documented evolution, not verified; storage outages surface as errors rather than stale data; part-size abuse is bounded, not eliminated (TD-13); `ListParts` consistency under node failure was not exercised.

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

**References:** AWS multipart overview https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html; AWS CompleteMultipartUpload https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html; AbortMultipartUpload https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html; ListParts https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html; multipart ETag https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html; E2.

**Decision:** _[pending]_

---

## TD-03: S3-compatible object storage server (MinIO)

**Scope:** Backend

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** *Problem:* the brief fixes MinIO in Docker as the local S3-compatible store, but the community edition is no longer maintained. *Requirements:* S3 multipart, `ListParts`/`Abort`, presigned URLs, CORS with a readable `ETag`, `Range` reads, `response-content-disposition`, persistence, a health endpoint, Compose reproducibility, free and open source. *Evidence (E1):* upstream `github.com/minio/minio` is archived (read-only since 2026-04-25) with the README "THIS REPOSITORY IS NO LONGER MAINTAINED" and "distributed as source code only", licensed AGPLv3; `dl.min.io` answers 410 and states MinIO provides no support, security updates or advisories for these releases; **`minio/minio` is not pullable** from Docker Hub, Quay or GHCR (also for the pinned tag); the repository's own `Dockerfile` is `FROM minio/minio:latest` and `Dockerfile.release` downloads from `dl.min.io` (410), so neither works as is. **But the candidate release `RELEASE.2025-09-07T16-13-09Z` is still published, with checksum and signature files, as GitHub release assets** — a different official origin than the one named in the brief. The binary was downloaded, matches its published SHA-256, and runs (E1). Git tag commit: `07c3a429bfed433e49018cb0f78a52145d4bedeb` (Go 1.24.0, toolchain go1.24.2). AGPLv3 §13 (read from the tag's `LICENSE`) obliges whoever **modifies** the program and offers it over a network to offer the corresponding source; an unmodified binary used locally does not trigger it, and publishing an image would (this is not legal advice; keep the image local/private).

**Options:**

### Option A: Pinned MinIO release from the GitHub release asset, SHA-256-verified custom image
- Build an image from a versioned base, download `minio.linux-amd64.<release>` from the GitHub release, verify the SHA-256 during the build and fail on mismatch, run as a non-root user with a named volume; never `latest`.
- **Pros:** satisfies the brief (MinIO, free, open source, S3-compatible); every S3 operation needed by this phase was verified on this build (E2); reproducible with a pinned release and hash; no registry dependency.
- **Cons:** unmaintained — **no security fixes**, so local/academic use only; depends on GitHub keeping the release assets; authenticity beyond the checksum needs the minisign signature (not run here); `mc` and the withdrawn `dl.min.io` downloads are unavailable.

### Option B: MinIO compiled from the source at the pinned tag
- Build with Go 1.24 from commit `07c3a429bfed433e49018cb0f78a52145d4bedeb` (the Makefile builds with `go build -tags kqueue -trimpath`).
- **Pros:** no dependence on the binary assets; the commit hash is a content-addressed anchor; same code as Option A.
- **Cons:** slower, heavier builds; AGPL obligations apply to any modification; not executed in this round; the produced binary is not the official one.

### Option C: MinIO AIStor Free
- A free tier of the commercial AIStor product (single node, "Redistribution is prohibited"; the pricing page calls it "commercially licensed").
- **Pros:** maintained by the vendor.
- **Cons:** license terms (`min.io/legal`), key requirement and distribution method could not be verified; no image or binary URL found on the pages read; not open source; redistribution prohibited conflicts with sharing the project's Compose setup.

### Option D: Another S3-compatible server (SeaweedFS, Garage or RustFS)
- Documentation-verified only (no smoke test run): SeaweedFS (Apache-2.0, `chrislusf/seaweedfs`), Garage (`dxflrs/garage`), RustFS (Apache-2.0, `rustfs/rustfs:1.0.5`).
- **Pros:** actively published images; maintained upstreams.
- **Cons:** deviates from the brief's MinIO; every capability would need its own smoke test; known gaps are listed in the comparison.

**Comparison (evidence as of 2026-11-11):**

| Server | Maintenance | S3 coverage evidence | Known limits | License | Complexity |
|---|---|---|---|---|---|
| MinIO pinned binary (A) | none (archived 2026-04-25) | **verified end to end** (E2) | bucket-level `PutBucketCors` → 501 (server-level CORS works); abort-incomplete lifecycle rejected alone | AGPLv3 | one binary; custom image |
| MinIO from source (B) | none | same code, not run | build time | AGPLv3 | Go toolchain build |
| AIStor Free (C) | vendor | not tested | terms unverified | commercial | unknown |
| SeaweedFS | active | docs: multipart + `ListParts`, presign, CORS, `Range`; lifecycle without transitions | multi-component architecture; abort lifecycle unconfirmed | Apache-2.0 | medium |
| Garage | active | docs: multipart + `ListParts`, presign, CORS; lifecycle supports `AbortIncompleteMultipartUpload` | `Range`/`response-content-disposition` not documented; license/version unverified | not verified | low |
| RustFS | active | docs: multipart, presign, `Range`, CORS; `ListParts` listed "Not Yet Passing" | `ListParts` edge cases (relied on by TD-02) | Apache-2.0 | low |

**Recommendation:** Option A, for the academic/local environment only — it is the only candidate whose behavior was demonstrated for every operation of this phase, it honors the brief's MinIO requirement, and the concrete blocker on the named source (`dl.min.io` 410) has a verified workaround (the GitHub release assets); Option D is not recommended merely because MinIO is unmaintained, and stays the documented fallback if the GitHub assets disappear or a smoke test of the built image fails.

**Trade-offs and risks:** an unpatched object store must not be exposed to the internet or hold real data; the build depends on one external URL (mitigation: keep the verified image in the local Docker cache, record the hash, document Option B as the rebuild path); AGPLv3 (keep the image private); root credentials in dev (documented risk); arm64 developers need the arm64 asset and its own checksum (listed on the release, not downloaded here); the built image and Compose healthcheck were not exercised.

**Implementation impact:** future Dockerfile — versioned base image (`debian:12-slim` pinned by tag and digest), `ARG` for the release and the verified SHA-256 `7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f`, download from `https://github.com/minio/minio/releases/download/RELEASE.2025-09-07T16-13-09Z/minio.linux-amd64.RELEASE.2025-09-07T16-13-09Z`, `sha256sum -c` that fails the build (the published checksum file names the asset `minio.RELEASE…`, so compare the hash, not the filename), optional minisign verification with the public key found in the tag's `Dockerfile.release`, `curl` for the healthcheck, non-root user, `VOLUME /data`, `HEALTHCHECK` on `/minio/health/ready`, credentials from `.env`; the bucket is created by the application at startup (no `mc`); topology in TD-16.

**References:** upstream repository and README https://github.com/minio/minio; release assets `https://github.com/minio/minio/releases/download/RELEASE.2025-09-07T16-13-09Z/` (downloaded and hash-verified in E1); `Dockerfile.release` and `LICENSE` at the tag (raw.githubusercontent.com); `dl.min.io` 410 notice (E1); Garage compatibility https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/; SeaweedFS S3 wiki https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API; RustFS matrix https://github.com/rustfs/rustfs/blob/main/docs/architecture/s3-compatibility-matrix.md; AIStor pricing https://www.min.io/pricing.

**Decision:** _[pending]_

---

## TD-04: S3 client library and endpoint/signing model

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** *Problem:* API and worker both talk to storage, and two network perspectives exist: containers reach it as `http://minio:9000`, while an upload client reaches a published endpoint (e.g., `http://localhost:9000`). *Requirements:* SigV4, `forcePathStyle`, CORS and readable `ETag`, presigned URLs with expiry, multipart commands, `HeadObject`/`GetObject`, no S3 credentials in source, no permanent credentials exposed to the client. *Evidence (E2):* a URL signed for `minio:9000` and then rewritten to `localhost:19000` fails with **403 `SignatureDoesNotMatch`**; a URL signed directly for the public host works; `X-Amz-SignedHeaders=host`, so the **host is part of the signature**; with `requestChecksumCalculation: "WHEN_REQUIRED"` the presigned part URL carries no checksum parameters, while the SDK default adds `x-amz-checksum-crc32` and `x-amz-sdk-checksum-algorithm` (the pinned MinIO still accepted that PUT; the AWS SDK changed this default in v3.729.0 and documents that some S3-compatible services do not support it). Presigning is an offline computation, so the API container does not need to reach the public host.

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) with two endpoints
- One client with the internal endpoint for server-side calls (multipart control, `ListParts`, `HeadObject`, `GetObject`) and one presign-only client built with the **public** endpoint, both with `forcePathStyle: true` and `requestChecksumCalculation: "WHEN_REQUIRED"`; URLs are generated by signing for the public host, never by editing the host of an existing URL.
- **Pros:** the reference S3 implementation, so the server stays swappable (TD-03); everything in this table was exercised (E2); typed API.
- **Cons:** two endpoint settings to get right; large, fast-moving dependency (pin versions); the SDK announces a Node ≥ 22 requirement for releases after the first week of January 2027 (containers run Node 25.6; the host's Node 20 would not).

### Option B: `minio` JavaScript SDK
- A MinIO-branded client with its own presign and multipart helpers.
- **Pros:** compact for common cases.
- **Cons:** coupled to a vendor whose server is archived; its maintenance was not verified; fewer guarantees on non-MinIO servers; nothing in this round exercised it.

**Recommendation:** Option A (direction approved by the brief) — portability and the demonstrated behavior (including the host-binding trap) outweigh the two-endpoint configuration cost.

**Trade-offs and risks:** a wrong `S3_PUBLIC_ENDPOINT` yields URLs that fail with `SignatureDoesNotMatch` only at upload time (add a configuration test that signs and uses a URL); in tests the runner is a container, so the public endpoint equals the internal one there (TD-15); presigned URLs are bearer tokens — TTL and logging hygiene matter (TD-13); `GetObjectCommand` with the `Range` parameter was not exercised directly (ranged `GET` through a presigned URL was).

**Implementation impact:** credentials only from environment variables validated by Joi, never in code, `.env.example` or responses; the client only ever receives presigned URLs (TTL ≤ 7 days is the SigV4 presign maximum; short by default); a shared S3 module used by API and worker; configuration keys in TD-16.

**References:** AWS SDK v3 checksum fallback note https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/MD5_FALLBACK.md; presigner README https://github.com/aws/aws-sdk-js-v3/blob/main/packages/s3-request-presigner/README.md; AWS presigned URLs https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html; E2.

**Decision:** _[pending]_

---

## TD-05: Background job queue and job-loss prevention

**Scope:** Backend

**Capability:** "Serviço de processamento em segundo plano (filas)"

**Context:** *Problem:* choose the queue and, above all, prevent losing the processing job when PostgreSQL commits `uploaded` but publishing to the queue fails. *Requirements (brief):* operational simplicity, cost, retries, backoff, concurrency, idempotency, recovery of interrupted jobs, queue persistence, Docker integration, basic observability; BullMQ + Redis is a candidate, not a given. Jobs are few and long (probe and thumbnail of large objects). Installed: NestJS 11.1.16, PostgreSQL 17, `pg` 8.20.0, Node 25.6.0. `pg-boss` also depends on `pg ^8.23.1`, so a second copy or an upgrade is implied. Regardless of the queue, the durable intent is the `uploaded` row; the reconciler of TD-14 re-publishes any job that is missing, with an idempotent key.

**Options:**

### Option A: `pg-boss` (queue in PostgreSQL)
- pg-boss 12.38.2 (Node ≥ 22.12, PostgreSQL ≥ 13): `retryLimit` (default 2), `retryDelay`, `retryBackoff`, `deadLetter` queue, `singletonKey`/queue policies, `expireInSeconds` (default 900 s) and optional `heartbeatSeconds`, `schedule()` (cron), `localConcurrency`, graceful `stop()`, `send(…, { db })` to enqueue through a caller-provided connection implementing `executeSql(text, values) → { rows }`.
- **Pros:** no new service; the enqueue can join the same PostgreSQL transaction as the state change, closing the loss window; retry/DLQ/heartbeat/schedule built in; state is inspectable with SQL.
- **Cons:** TypeORM's `QueryRunner.query` returns rows only while pg-boss needs the full `pg` result for multi-statement text — an adapter over the underlying connection (`queryRunner.connect()` returns the `pg` client holding the open transaction) is plausible but **unvalidated**; the `pgboss` schema is created by the library, outside TypeORM migrations (DDL available through `getConstructionPlans()`) and outside the test-DB reset (TD-15); `expireInSeconds` must exceed the longest job; PostgreSQL polling load.

### Option B: BullMQ on Redis (`@nestjs/bullmq`)
- bullmq 6.7.4; `@nestjs/bullmq` 12.0.1 accepts `@nestjs/core ^11`. `attempts`/`backoff`, `jobId` deduplication, stalled-job recovery (30 s lock, `maxStalledCount` 1), `removeOnComplete/Fail`.
- **Pros:** the mainstream Nest queue; strong tooling and throughput headroom.
- **Cons:** a new stateful service; the production guide requires `maxmemory-policy noeviction` and recommends AOF persistence; the enqueue cannot be atomic with the PostgreSQL commit, so the reconciler becomes mandatory; one more service for Compose, test isolation and teardown.

### Option C: Own PostgreSQL job table with a polling worker (`FOR UPDATE SKIP LOCKED`)
- A `video_jobs` row (or columns on `videos`) with `status`, `attempts`, `run_at`, `locked_until`; workers claim rows with `SELECT … FOR UPDATE SKIP LOCKED` (PostgreSQL documents it for queue-like tables, noting it gives an inconsistent view for general use).
- **Pros:** zero dependency; the enqueue is trivially transactional (same insert); fully TypeORM and migration-friendly; trivially testable.
- **Cons:** retries, backoff, leases, dead-lettering and scheduling are ours to write and test; no off-the-shelf observability.

### Option D: RabbitMQ (NestJS RMQ transporter)
- A broker with manual acknowledgement (`noAck: false`), `persistent`, `queueOptions`, `prefetchCount`; an unacknowledged message is redelivered if the consumer dies.
- **Pros:** purpose-built broker; matches the diagram's "Message Queue" box literally.
- **Cons:** the Nest docs read describe no retry/backoff/dead-letter behavior (broker-level DLX/TTL or custom code); a new broker; no scheduling for TD-14; heaviest operations.

**Recommendation:** Option A — it reuses the PostgreSQL already in the stack, adds no service, and offers the retries, backoff, dead-lettering, heartbeat and scheduling this phase needs at the expected volume; it is conditional on the validation spike listed below, and if transactional enqueue does not work the fallback is a durable, documented and tested outbox/reconciliation on PostgreSQL — Redis is **not** introduced as a silent fallback (BullMQ stays a separately decided alternative).

**Trade-offs and risks:** gives up Redis-grade throughput and ecosystem (not needed at this scale); two copies of `pg` or an upgrade; `pgboss` schema outside migrations/test reset; v12 is a recent major (verify the API against the docs at implementation time). Basic observability: queue state is queryable through SQL, and the pg-boss project lists a `@pg-boss/dashboard` web UI (not evaluated here); BullMQ dashboards were not evaluated.

**Implementation impact:** job key = video id (idempotent publication); handler idempotent (same outputs overwrite the same keys); retry with backoff for transient errors, dead-letter/`failed` for permanent ones (TD-09); worker graceful stop on `SIGTERM`; `expireInSeconds` and optional heartbeat sized to the longest job; the API only publishes, the worker consumes (TD-06). **Planning condition — the spike must prove:** (1) the chosen `pg-boss` version is compatible with the installed TypeORM and `pg` (it requires `pg ^8.23.1`; the repo has 8.20.0); (2) `send(…, { db })` enqueues inside the **same transaction** as the video state change, through an adapter over TypeORM's underlying connection; (3) a **rollback** publishes no job; (4) a **commit** preserves both the video state and the job; (5) the `pgboss` schema is initialized deterministically (library installation, or DDL from `getConstructionPlans()` applied by a migration) and (6) is isolated and reset in the tests; (7) deduplication by key, retries with backoff, heartbeat and recovery of interrupted jobs behave as documented; (8) **no database transaction stays open while a video is being processed** — claims are short and processing runs outside any transaction. The spike result is a validation condition of the planning stage; if (2)–(4) fail, implement the outbox/reconciliation fallback (the `uploaded` row as durable intent plus the reconciler of TD-14) with its own tests.

**References:** pg-boss docs and `package.json` https://github.com/timgit/pg-boss (`docs/api/jobs.md`, `docs/api/queues.md`, `docs/api/adapters.md`); BullMQ production guide https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/going-to-production.md; `@nestjs/bullmq` https://github.com/nestjs/bull; NestJS RabbitMQ https://docs.nestjs.com/microservices/rabbitmq; TypeORM `PostgresQueryRunner` (installed 0.3.28).

**Decision:** _[pending]_

---

## TD-06: Media worker topology and responsibilities

**Scope:** Backend

**Capability:** "Serviço de processamento em segundo plano (filas)"; "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** *Problem:* the worker must be an independent process/container, yet share the domain model. A worker inside the API process is excluded (contradicts the architecture diagram and the brief). The dev base image `node:25.6.0-slim` is Debian 12, whose `apt` offers FFmpeg 5.1.9 (E3). *Responsibilities:* **API** — authenticate/authorize, create drafts and uploads, mint part URLs, validate and complete, publish the job, emit playback/download URLs, expose status; **worker** — consume jobs, probe and thumbnail through FFmpeg, persist metadata and status, retry/fail, clean temporary files, run the scheduled reaper/reconciler (TD-14); **neither** moves file bytes during upload.

**Options:**

### Option A: Second entrypoint in `nestjs-project`, separate Compose service
- A `worker` bootstrap (`NestFactory.createApplicationContext`, no HTTP) sharing modules, entities, migrations and config; its own Compose service and Docker target that installs `ffmpeg`.
- **Pros:** no duplicated domain code; one test harness and migration history; the API image stays free of FFmpeg; independent scaling and resource limits.
- **Cons:** one codebase, two runtime shapes (a clear module boundary keeps worker-only code out of the API).

### Option B: Separate subproject (`video-worker/`)
- **Pros:** hard isolation; independent dependencies.
- **Cons:** duplicates or extracts entities/config/migrations (the repo has no shared package); two lockfiles and test setups for one domain model.

### Option C: Nest monorepo mode (`apps/api`, `apps/worker`, `libs/*`)
- **Pros:** the official multi-app layout.
- **Cons:** reorganizes the source tree, Jest roots and the freshly stabilized test baseline for a benefit Option A mostly achieves with one extra file.

**Recommendation:** Option A — it meets "worker independente" with the least duplication and leaves the existing layout and test baseline intact.

**Trade-offs and risks:** the worker needs database and storage credentials too (same validated config); a worker crash mid-job relies on queue expiry/heartbeat plus idempotent handlers (TD-05, TD-09); only one instance should run the scheduled reaper (singleton job).

**Implementation impact:** Compose service `worker` (same code, FFmpeg-enabled image target, `depends_on` the database and storage health), CPU/memory limits on that service, non-root user, no published ports; shared S3 and queue modules; entrypoint file and build target are implementation details for `plan-build`.

**References:** NestJS standalone applications (Context7 docs); architecture diagram `docs/diagrams/software-arch.mermaid`; E3.

**Decision:** _[pending]_

---

## TD-07: FFmpeg/ffprobe toolchain, validity rules and resource limits

**Scope:** Backend

**Capability:** "Processamento automático do vídeo após upload (extração de duração e metadados)"; "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** *Problem:* extract duration and metadata, generate a thumbnail, recognize invalid files, classify failures, bound CPU/memory/temporary resources and clean up — with no full transcoding (not demanded by the acceptance criteria). *Evidence (E3, FFmpeg/ffprobe 5.1.9 from Debian 12, reading presigned GET URLs):* `ffprobe -v error -show_entries format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,width,height -of json <url>` returned the container, `duration` and the h264/aac streams; `ffmpeg -nostdin -v error -ss <t> -i <url> -frames:v 1 -q:v 2 -y <file.jpg>` produced a JPEG (signature `ffd8ff`); random bytes and a text file → ffprobe **exit 1**, message "Invalid data found when processing input", no streams; a **truncated** MP4 (header intact, data cut) → **exit 0** with two streams and the full declared duration; a tampered signature → exit 1 "Server returned 403 Forbidden"; connection refused → exit 1 — **exit codes alone cannot separate permanent from transient errors**; **every error message contains the presigned URL including `X-Amz-Signature`**; measured peak memory ≈ 55 MB (ffprobe) and ≈ 98–141 MB (thumbnail) for a 359 MiB file. Docs: `-rw_timeout` is in **microseconds** (global protocol option); `-probesize` (default 5,000,000 bytes) and `-analyzeduration` (default 5,000,000 µs) are format options; the http protocol has `seekable` (default autodetect) and `reconnect*` options; `-movflags +faststart` moves the `moov` atom to the start in a second pass and is not default.

**Options:**

### Option A: System `ffmpeg`/`ffprobe` binaries via `child_process.spawn` (argument arrays, no shell)
- Installed in the worker image (Debian 12: 5.1.9, pin the package version); fixed argument lists, JSON parsing, a wall-clock timeout that kills the process, bounded probing options, a concurrency cap and container CPU/memory limits.
- **Pros:** no wrapper dependency; exact control of flags; no shell, so no injection through object names; behavior reproduced in E3.
- **Cons:** we own argument building, timeouts, stderr handling and exit-code mapping; behavior follows the image's FFmpeg version.

### Option B: `fluent-ffmpeg` wrapper
- **Pros:** familiar fluent API.
- **Cons:** deprecated on npm ("no longer supported") and the repository is archived (last 2.1.3).

### Option C: Static-binary npm packages (e.g., `ffmpeg-static`/`ffprobe-static`)
- **Pros:** the same FFmpeg everywhere.
- **Cons:** not evaluated in this round — fetched at install time (supply chain) and the bundled build's licensing needs review; the image can provide FFmpeg without it.

**Recommendation:** Option A — two fixed commands do not justify a wrapper, and the deprecated one is a poor foundation; everything the brief asks (duration, metadata, thumbnail, invalid files, limits) was demonstrated with the raw binaries.

**Trade-offs and risks:** a file that passes `ffprobe` may still be incomplete — therefore completeness is established by the size check of TD-02 and by treating a failed thumbnail decode as a processing failure; log hygiene — tool messages echo the whole presigned URL, so **remove the entire query string (credential, signature, date, expiry and token parameters) from anything logged or stored, and never persist a presigned URL in an error message or in `failure_reason`**; hostile files exploit decoder bugs — run unprivileged, with CPU/memory limits and a hard timeout, and keep FFmpeg patched via the image; the accepted-format rule below is a human decision for this phase and is deliberately narrow.

**Implementation impact:** **accepted media (human decision):** MP4 with H.264 video and optional AAC audio; everything else is rejected as unsupported (`failed`, reason `UNSUPPORTED_FORMAT`, permanent, no retry) with no transcoding promised. The rule is decided from the probe, **never from the file extension or the declared MIME**: container `format_name` contains `mp4` **and** `major_brand` belongs to an MP4-family allowlist (E5: MP4 → `isom`; MOV → `qt  ` and 3GP → `3gp6` share the same `format_name` and are told apart only by the brand; an MKV saved as `.mp4` reports `matroska,webm`), first video stream codec `h264` (HEVC, VP9… rejected) with pixel format `yuv420p` (a 4:4:4 stream is rejected as a playback-compatibility policy), audio absent or `aac` (MP3… rejected), duration > 0 (and ≤ a configured maximum); only the brand `isom` was observed in E5, so the allowlist is completed with fixtures in the plan; failure classification by cause: invalid media (permanent) vs storage/network (transient → retry) — classify by stderr pattern or by a `HeadObject` pre-check, not by exit code; the thumbnail position is a policy (a fraction of the duration with lower/upper bounds, start for very short clips); the thumbnail is written to a per-job temp directory, uploaded through the SDK, and the directory is removed in a `finally` block on success and failure; no transcoding, HLS or multiple resolutions in this phase (documented evolution).

**References:** FFmpeg http protocol https://ffmpeg.org/ffmpeg-protocols.html; ffprobe https://ffmpeg.org/ffprobe.html; formats/`faststart`/`probesize` https://ffmpeg.org/ffmpeg-formats.html; `fluent-ffmpeg` https://npmjs.com/package/fluent-ffmpeg; E3.

**Decision:** _[pending]_

---

## TD-08: Processing input access and scratch storage

**Scope:** Backend

**Capability:** "Processamento automático do vídeo após upload (extração de duração e metadados)"; "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** *Problem:* the source object can be 10 GB; the worker either reads it remotely or copies it locally, which decides scratch disk, start-up time and cleanup. *Evidence (E3):* over HTTP, ffprobe on a **359 MiB** object with the `moov` atom at offset 377,378,337 completed in 0.06 s with **three** ranged requests (`bytes=0-`, `bytes=48-`, `bytes=377378333-`) — it seeks to the tail instead of reading the file; the thumbnail at t = 50 s took 0.16 s with four ranged requests (including `bytes=190067041-`). A 10 GB object was **not** tested. Related: TD-07, TD-09.

**Options:**

### Option A: Read directly over HTTP using a short-lived presigned GET (internal endpoint)
- **Pros:** no scratch disk and no download time; start-up is immediate; nothing large to clean up.
- **Cons:** depends on the server honoring `Range`; the URL TTL must exceed the job timeout; the URL leaks through tool messages unless redacted (TD-07); behavior at 10 GB is unproven.

### Option B: Download to ephemeral storage, then process the local file
- **Pros:** deterministic; independent of HTTP seeking.
- **Cons:** up to 10 GB (plus margin) of free disk per concurrent job; download time before every job; orphan temp files.

### Option C: Read over HTTP, fall back to a download only when reading fails
- **Pros:** fast common path with an escape hatch.
- **Cons:** two code paths to test; the fallback still needs provisioned scratch space.

**Recommendation:** Option A — processing reads by HTTP Range, falling back to a local copy (Option C) only if tests demonstrate it is needed; the measured seek behavior removes the need to copy large files for the operations this phase performs.

**Trade-offs and risks:** presigned-URL TTL vs job duration (the URL is a temporary credential: never logged or persisted, TD-07); heavy random seeking on very large files is unverified; keep the concurrency cap so remote reads do not saturate storage.

**Implementation impact:** the worker presigns with the **internal** endpoint (TD-04); a `finally` block removes the per-job temp directory; if Option C is adopted, size scratch space as concurrency × maximum object size.

**References:** FFmpeg http protocol (`seekable`, `reconnect*`) https://ffmpeg.org/ffmpeg-protocols.html; E3.

**Decision:** _[pending]_

---

## TD-09: Video lifecycle state machine and failure handling

**Scope:** Backend

**Capability:** "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"; "Processamento automático do vídeo após upload (extração de duração e metadados)"; "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** *Problem:* define the valid states and transitions, cancellations, retries and duplicate events; the backend is the only authority for transitions. Phase 04 adds the draft → published flow, visibility and a status column in the channel panel, so the model is reused. *Mapping of the brief's list:* draft → `publication = draft` (from creation); upload in progress/incomplete → `uploading`; upload completed + processing pending → `uploaded`; processing running → `processing`; ready → `ready`; processing failure → `failed`.

**Options:**

### Option A: Two orthogonal fields — `publication` and `processing_status` — with compare-and-set transitions
- `publication` (draft now; published/visibility arrive in Phase 04) is independent of `processing_status` ∈ {`uploading`, `completing`, `uploaded`, `processing`, `ready`, `failed`, `expired`, `cancelled`}. Every transition is a conditional update (`WHERE status = :expected`); a zero-row update means a duplicate or racing event and is ignored.
- **Pros:** the draft requirement and the pipeline do not collide; Phase 04 is additive; idempotent transitions make queue redelivery safe.
- **Cons:** two columns to keep coherent (a published video must be `ready`); the UI needs a small derivation.

### Option B: One combined status enum
- **Pros:** one field.
- **Cons:** states multiply as visibility rules arrive in Phases 04–05, forcing enum migrations and transition rewrites.

### Option C: Append-only transitions table with derived status
- **Pros:** full history and auditing.
- **Cons:** more schema and queries than this phase needs; derived reads must stay fast and consistent.

**Recommendation:** Option A — it separates the two concerns the brief names and makes duplicate, retried and racing events harmless by construction.

**Trade-offs and risks:** the extra `completing` state needs the stale-claim recovery of TD-14; cancellation (abort) is supported only for incomplete uploads — a human decision; cancelling a processing already started is not required in this phase; a manual "retry failed video" action is not required by the capabilities.

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

**References:** AWS Complete/Abort semantics (TD-02); pg-boss retry options (TD-05).

**Decision:** _[pending]_

---

## TD-10: Unique public video identifier and storage keys

**Scope:** Backend

**Capability:** "URL única por vídeo, sem conflito com outros vídeos"

**Context:** *Problem:* a short unique identifier, available from the draft, without collisions; the **public identifier must differ from the private storage keys**. *Constraints:* uniqueness must be a database constraint; collision handling must not repeat the retry-inside-an-aborted-transaction error recorded as CHANNEL-NICKNAME-RACE (a unique violation aborts the PostgreSQL transaction; later statements fail with `25P02`). Library facts: `nanoid` 6.0.2 is ESM-only with `engines` `^22 || ^24 || >=26` (excludes the containers' Node 25.6); `nanoid` 3.x is CommonJS; `sqids` is 0.3.0 and its CommonJS support was not verified.

**Options:**

### Option A: Random base62 identifier (≈ 11 characters) with a unique index
- Generated from `crypto` randomness without modulo bias (a few lines, no dependency): 62^11 ≈ 5.2 × 10^19 values; the birthday collision chance is about 10^-8 at one million videos and about 10^-4 at one hundred million, so the constraint stays mandatory. Insert with `INSERT … ON CONFLICT DO NOTHING` (or an insert guarded by the unique index) and retry a bounded number of times **outside** any aborted transaction.
- **Pros:** short, non-enumerable, no dependency or ESM/engine issue.
- **Cons:** a small amount of collision-handling code.

### Option B: Encode a database sequence with Sqids
- **Pros:** collision-free by construction; very short.
- **Cons:** reversible and ordered (reveals creation order, enumerable); a pre-1.0 dependency.

### Option C: UUID (v4 or v7) as the public identifier
- **Pros:** no collision handling; native to PostgreSQL.
- **Cons:** 36 characters — not the short URL the brief asks for; v7 leaks creation time.

**Recommendation:** Option A — the only option that is short and non-enumerable without a dependency; the unique index plus a bounded `ON CONFLICT` retry removes the collision risk without the aborted-transaction trap.

**Trade-offs and risks:** the identifier carries no meaning (by design); length/alphabet are configurable but changing them later affects existing URLs.

**Implementation impact:** `videos.public_id` with a `UNIQUE` constraint, generated at the draft step; **storage keys are derived only from the internal UUID primary key** (e.g., `videos/<uuid>/original`, `videos/<uuid>/thumbnail.jpg`), never from `public_id` or from the client's filename; the original filename is stored as sanitized metadata used only for `Content-Disposition` (TD-11).

**References:** npm registry metadata for `nanoid`/`sqids` (2026-11-11); PostgreSQL error behavior in an aborted transaction (the recorded CHANNEL-NICKNAME-RACE evidence, `25P02`).

**Decision:** _[pending]_

---

## TD-11: HTTP streaming and download delivery

**Scope:** Backend

**Capability:** "Reprodução via streaming (sem necessidade de download completo)"; "Download do vídeo pelo usuário"

**Context:** *Problem:* deliver playback with Range support and a download, with authorization, without moving the bytes through NestJS or Next.js. *Requirements (brief):* Range requests, `206`, `Content-Range`, `Content-Length`, `Accept-Ranges`, MIME type, invalid requests, authorization, unprocessed videos, no credentials exposed; a full-file download does not by itself satisfy streaming. The architecture diagram shows the client reading from object storage, and `next-frontend-config-base/TD-03` already points to presigned URLs for videos. *Evidence (E2, E4):* the pinned MinIO answers a presigned ranged `GET` with `206`, `Content-Range: bytes 0-99/11534336`, `Content-Length: 100`, `Accept-Ranges: bytes`, and honors `response-content-disposition`; its `416` carries no `Content-Range`, and an invalid `Range` (`garbage`) or a multi-range request is simply ignored (200 full body) — RFC 9110 uses `SHOULD` for the `416` `Content-Range` and lets a server ignore `Range` or an invalid `Range`, so none of this is non-conformant; unsigned or expired URLs → 403. NestJS `StreamableFile` has no Range handling, and Express 5.2.1 `req.range(size)` only parses the header (relevant to the proxy alternative).

**Options:**

### Option A: API authorizes, then emits a short-lived presigned GET URL; the client issues Range requests directly to storage
- A playback operation and a download operation each authorize the caller (TD-12), require a `ready` video, and return a presigned URL plus its `expires_at`; download URLs carry `ResponseContentDisposition` (`attachment; filename=…`, sanitized) and the media type. Range, `206`, `Content-Range` and `Accept-Ranges` are served by the storage.
- **Pros:** the bytes never cross the API; no long-lived API connections; consistent with the architecture diagram; authorization happens when the URL is minted; verified end to end on the pinned build.
- **Cons:** the Range/416 contract is storage-defined (acceptable per RFC 9110, but it varies across S3 servers); the URL is a temporary credential until it expires (TTL and renewal needed for long playback); requires the public endpoint (TD-04); `response-content-disposition` support is verified only on the pinned build.

### Option B: API streaming proxy with Range support (`GetObject` with `Range`, piped to the response)
- The endpoint authorizes on every request, parses `req.range(size)` against the stored size and pipes exactly the requested range with `206`/`Content-Range`/`Content-Length`.
- **Pros:** per-request authorization and revocation; the response contract is API-owned.
- **Cons:** all playback and download traffic crosses the API (connections, bandwidth and CPU scale with viewers); backpressure and client-abort handling to implement; against the architecture's direct-from-storage reading.

### Option C: Hybrid — stream through the API, download through a presigned URL
- **Pros:** API-owned playback contract; downloads offload bandwidth.
- **Cons:** two delivery mechanisms and two authorization moments; keeps the playback bytes on the API.

**Recommendation:** Option A (adjusted by the architecture review) — it keeps the transfer off NestJS and Next.js, matches the planned architecture, preserves authorization at URL emission and was demonstrated on the pinned storage; the API proxy stays a documented future alternative (Option B) for when per-request authorization/revocation or strictly RFC-recommended Range responses become necessary.

**Trade-offs and risks:** the emitted URL is a **temporary credential**: whoever holds it can read the object until it expires, so it is never logged or persisted and the emitting response is `Cache-Control: no-store`; a media element re-requests ranges with the same URL while seeking and buffering, so an expired URL makes later requests fail with 403 (verified) — hence a TTL covering a normal session plus renewal; browser behavior at the moment of expiry was not tested; Range responses depend on the storage server (invalid/multi-range ignored, `416` without `Content-Range` on the pinned build); a revoked right (future ownership/visibility change) takes effect only at the next emission or at expiry.

**Implementation impact:** behavior to specify and test — emission is owner-only (TD-12) and returns `{ url, expires_at }`; videos not `ready` are refused with a domain error (e.g., `VIDEO_NOT_READY`, 409); another channel's video → 404; TTLs are configurable (proposed defaults: playback 1 hour, download 15 minutes) and the client renews by requesting a new URL before `expires_at`, swapping the source and keeping the playback position; the response never contains permanent credentials (only the presigned URL and its expiry); the URL is presigned for the **public** endpoint (TD-04). Tests: API level with `supertest` — authorization, `ready`-only, channel isolation, `no-store`, no credential material in the body; storage level with plain `fetch` against the emitted URL — `206` with `Content-Range`/`Content-Length`/`Accept-Ranges` for a valid range, `200` for an invalid range (permitted), `416` for an unsatisfiable range (without asserting a `Content-Range` the pinned build does not send), `Content-Disposition` on the download URL, `403` after expiry and for an unsigned request.

**References:** RFC 9110 §14 and §15.3.7/§15.5.17 https://www.rfc-editor.org/rfc/rfc9110.html; MDN range requests https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests; AWS presigned URLs https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html; NestJS streaming files https://docs.nestjs.com/v11/techniques/streaming-files; Express `req.range` (Express repo docs, `request.md`); E2.

**Decision:** _[pending]_

---

## TD-12: Authorization, ownership by channel and channel isolation

**Scope:** Backend

**Capability:** "Reprodução via streaming (sem necessidade de download completo)"; "Download do vídeo pelo usuário"; "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** *Problem:* define who may start, complete, abort, view status, stream and download, and guarantee isolation between channels. Phase 03 produces only drafts: visibility (public/unlisted) belongs to Phase 04 and anonymous viewing to Phase 05, but the capabilities already require streaming and download. Authentication is inherited: `JwtAuthGuard` is global and `@Public()` opts out. Ownership: each channel belongs to exactly one user (`channels.user_id` is unique), and a video belongs to a channel. Human decision (architecture review): downloads are owner-only until publication/visibility exist in later phases.

**Options:**

### Option A: Owner-only until published, enforced by one policy function
- A single `assertCanAccess(video, user?)` decides; in Phase 03 only the owner of the video's channel may act on or obtain streams of non-published videos; Phases 04–05 add published/unlisted/anonymous branches by editing that function (and `@Public()` where needed).
- **Pros:** safe default for drafts; one extension point; consistent with the global guard.
- **Cons:** anonymous or shared viewing cannot be demonstrated in this phase.

### Option B: Capability URL — anyone holding the public id may stream
- **Pros:** anonymous playback works immediately.
- **Cons:** drafts exposed to anyone who learns the id; hard-codes "unlisted" before Phase 04 decides it.

### Option C: Owner-minted, expiring share tokens
- **Pros:** explicit sharing with expiry.
- **Cons:** a token model no Phase 03 capability asks for; overlaps Phase 04's unlisted links.

**Recommendation:** Option A — the secure default for drafts at the cost of one function that Phases 04–05 extend.

**Trade-offs and risks:** answering 404 (not 403) for videos the caller does not own prevents id enumeration but hides the reason from legitimate mistakes; consistency of the rule across every endpoint depends on routing all checks through the one function and testing each operation against a second channel; an emitted presigned URL remains a temporary credential until it expires (TD-11), so a rights change takes effect at the next emission or at expiry.

**Implementation impact:** authorization matrix —

| Operation | Rule |
|---|---|
| start upload | authenticated user with a channel; video created under that channel |
| part URLs, status/resume, complete, abort | owner of the video's channel, video in an allowed state |
| emit playback / download URL | owner of the video's channel; `ready` only (other states → 409); others later per Phases 04–05 |
| any operation on another channel's video | 404 `VIDEO_NOT_FOUND`, never reveals existence |

Channel-isolation tests: a second authenticated user cannot start-with, complete, abort, list parts of, stream or download the first user's video (TD-15).

**References:** `phase-02-auth/TD-02` (guards), `TD-07` (error contract); `src/channels/entities/channel.entity.ts` (one channel per user).

**Decision:** _[pending]_

---

## TD-13: Upload validation, abuse controls and untrusted-file handling

**Scope:** Backend

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** *Problem:* the storage layer will not enforce limits for us, and uploaded files are untrusted. *Evidence:* the size-range condition (`content-length-range`) belongs to presigned **POST** policies, not to per-part presigned **PUT** URLs; pinning a part size would mean signing `Content-Length` (the presigner's `signableHeaders`), unverified on the pinned build (E2/E4). `Complete` accepts a missing part (E2); a truncated MP4 passes `ffprobe` (E3); ffprobe error text contains the presigned URL (E3); aborting an upload makes its outstanding part URLs fail with `NoSuchUpload` (E2). *Requirements (brief):* JWT auth, ownership by channel, authorization for each operation, the 10 GB limit validated on the server, content/format verification, protection against misuse of presigned URLs, expiry and operational revocation, safe handling of object names/keys, processing of untrusted files, behavior under network failure and unavailability.

**Options:**

### Option A: Layered controls — declared limits, size verification at completion, `ffprobe` as the content judge, per-user quotas
- At start: authenticated user with a channel, declared size ≤ `MAX_UPLOAD_BYTES` (10 GiB), advisory MIME/extension hint (never proof of compatibility; the media rule of TD-07 decides), per-user cap on concurrent open uploads and pending bytes, throttled control endpoints. At completion: part set and sizes from `ListParts`, sum equals the declared size, `HeadObject` confirms. In the worker: `ffprobe` must find a supported video stream, else `failed` with a reason.
- **Pros:** authoritative content check without extra I/O; failures visible through the state machine; each control is testable.
- **Cons:** a hostile or oversized upload occupies storage until completion fails or expiry (bounded by TD-14).

### Option B: Option A plus a synchronous magic-byte sniff at completion
- After completion, read the first KB with a ranged `GET` and check the container signature before enqueuing.
- **Pros:** obvious non-videos are rejected before queue work.
- **Cons:** a second validation path to maintain that `ffprobe` repeats; one more storage read in the request path.

### Option C: Option A with a quarantine prefix and promotion after validation
- **Pros:** unvalidated content never sits under a final key.
- **Cons:** server-side copy of an object over 5 GB requires multipart copy (single `CopyObject` is limited to 5 GB) and doubles storage I/O; `ready`-only delivery (TD-11/TD-12) already hides unvalidated content.

**Recommendation:** Option A — `ffprobe` is the authoritative parser, the state machine already provides the rejection path, and the size/part checks plus quotas close the abuse vectors that matter for this phase.

**Trade-offs and risks:** residual risk — the pending-bytes quota counts the declared size, and actual bytes uploaded can exceed it until expiry/abort (bounded by short expiry; a periodic `ListParts` audit is an evolution); presigned URLs are bearer tokens until expiry or abort; the worker processes untrusted media (mitigated by process isolation, limits and patching); `Retry-After`/503 semantics under outages must be consistent.

**Implementation impact:** server-generated object keys only (TD-10); filenames sanitized (strip paths/control characters, RFC 6266 encoding) and used only for `Content-Disposition`; per-part URL TTL short and re-requestable; abort as the operational revocation (verified to invalidate outstanding part URLs); throttler limits on control endpoints (existing `@nestjs/throttler`, in-memory, single instance); worker runs as a non-root user without a shell, with timeouts and Compose resource limits; remove presigned URLs and every signature/credential parameter from logs and stored failure reasons (never persist a presigned URL); `MAX_UPLOAD_BYTES` configurable so the limit logic is tested with small values.

**References:** AWS presigned URLs https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html; AWS POST policy conditions (`content-length-range`, AWS SDK docs); AWS CopyObject 5 GB limit https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html; E2, E3.

**Decision:** _[pending]_

---

## TD-14: Orphan resource cleanup and reconciliation

**Scope:** Backend

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"; "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"; "Serviço de processamento em segundo plano (filas)"

**Context:** *Problem:* abandoned uploads leave open multipart uploads (they hold storage), draft rows that never completed, stale `completing` claims, and — if queue and database disagree — `uploaded` videos without a job. Pontos de Atenção stresses storage cost. *Evidence (E2):* `ListMultipartUploads` returns open uploads with their initiation time; `AbortMultipartUpload` is idempotent and subsequent `ListParts`/`Complete`/part `PUT` fail with `NoSuchUpload`; on the pinned build `PutBucketLifecycleConfiguration` with `AbortIncompleteMultipartUpload` **alone is rejected (400)** and is accepted only in a rule that also has an expiration action (which would delete videos — unsafe), and enforcement was not verified; AWS notes in-flight parts may still land after an abort, so repeat abort until `ListParts` is empty. Garage documents support for the action; SeaweedFS and RustFS were not confirmed.

**Options:**

### Option A: Scheduled reaper/reconciler job (queue scheduler, singleton)
- Aborts open multipart uploads older than the threshold, marks stale `uploading` drafts `expired`, resolves stale `completing` claims (`HeadObject`/`ListParts` evidence decides, never a timeout alone — TD-02), re-enqueues `uploaded` videos with no job, and optionally lists orphan objects for review.
- **Pros:** portable across storage servers; also repairs database/queue drift, which lifecycle rules cannot; thresholds configurable and testable.
- **Cons:** code to write and monitor; must run as a singleton.

### Option B: Storage lifecycle rule only
- **Pros:** no application code.
- **Cons:** day-granular; unsupported or unsafe on the pinned build (E2); leaves stale rows and missing jobs untouched.

### Option C: Both — reaper primary, lifecycle rule as a backstop where supported
- **Pros:** defense in depth for the costliest leak.
- **Cons:** two mechanisms to configure; the backstop cannot be assumed on every server.

**Recommendation:** Option A — it works on the pinned build where Option B does not and also reconciles state; Option C stays an optional hardening for servers that enforce the lifecycle action.

**Trade-offs and risks:** an aggressive threshold could abort a slow but healthy upload (use expiry ≥ the longest plausible upload plus margin, and let part-URL requests extend the window); the reaper itself must be idempotent and tolerate partial failure; orphan *objects* (object without a row) are only reported, not deleted automatically.

**Implementation impact:** reaper/reconciler scheduled through the queue (TD-05) and executed by the worker (TD-06); configurable thresholds (`UPLOAD_EXPIRY_HOURS`, `COMPLETING_STALE_MINUTES`); abort is repeated until `ListParts` is empty; every action transitions state through the same compare-and-set rules (TD-09).

**References:** AWS AbortMultipartUpload https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html; pg-boss `schedule()` docs; Garage compatibility page (TD-03); E2.

**Decision:** _[pending]_

---

## TD-15: Test strategy for storage, queue, worker and the API contract (no frontend)

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** *Problem:* prove real behavior — multipart, presigned URLs, completion races, queue delivery, FFmpeg processing, Range delivery and authorization — without a frontend, inside the repo's test model (real services, destructive reset behind guards, serialized, always in the container). The earlier CHANNEL-NICKNAME-RACE showed that mocked unit tests hid a defect that only a real database exposed. A concrete interaction: TypeORM's reset clears the tables and enums of the entity schemas and `current_schema()`, so a library-managed `pgboss` schema (TD-05 Option A) survives it and would leak jobs across runs unless reset explicitly. Feasibility evidence (E2/E3): an 11 MiB, 3-part presigned upload plus completion, ranged reads, abort and concurrency scenarios ran in seconds with plain `fetch`; FFmpeg `lavfi` test sources generated valid MP4 fixtures (with and without `faststart`), and invalid/truncated fixtures behaved as described in TD-07.

**Options:**

### Option A: Real services in Docker Compose with isolation guards; fakes only for unit tests
- A dedicated test bucket whose name must match a test-only pattern (refused otherwise, like the DB guard), an explicit queue-schema reset in the global setup/teardown, deterministic generated fixtures, HTTP-level tests (`supertest` for the API, `fetch` `PUT`s to presigned URLs standing in for the client), the public S3 endpoint set equal to the internal one in the test environment, small `MAX_UPLOAD_BYTES`/part-size values to exercise the limit logic without 10 GiB payloads.
- **Pros:** exercises the real multipart/presign/Range/queue/FFmpeg behavior that mocks cannot prove; reuses the existing Compose and serial-run model; runs without a frontend.
- **Cons:** slower runs; more services up; new guard code.

### Option B: Fakes/mocks only (in-memory S3 and queue stubs)
- **Pros:** fast; no extra services.
- **Cons:** cannot validate host-bound signatures, completion races, `ListParts` pagination, Range behavior or transactional enqueue — the very risks of TD-01..TD-05.

### Option C: Testcontainers started per run
- **Pros:** hermetic per-run services.
- **Cons:** needs Docker-socket access from the test container (not available), a new tool and a different model from "Compose up, then test in the container".

**Recommendation:** Option A — it keeps the project's testing pyramid and places the real-service checks where the highest risk lives; the guards must refuse any non-test bucket or queue schema before a reset.

**Trade-offs and risks:** a full 10 GiB end-to-end upload is excluded from the default suite (run manually as a performance/acceptance check); tests depend on the built MinIO image being available locally; guard code is new surface to review.

**Implementation impact:** fixtures — a valid MP4 with `faststart`, one with the `moov` atom at the end, random bytes, a text file and a truncated MP4; contract tests for each API operation (start, part URLs, resume, complete, abort, status, playback/download URL emission) and storage-level tests with plain `fetch` against the emitted URLs (`Range` cases, `Content-Disposition`, expiry — TD-11); media-rule fixtures — accepted: H.264+AAC and H.264 without audio; rejected: HEVC, VP9/WebM, MKV saved as `.mp4`, MOV, 3GP, 4:4:4 H.264, MP3 audio, truncated file, random bytes, text; a redaction test asserting that no `X-Amz-*` parameter or presigned URL is logged or persisted; concurrency tests (parallel completes, duplicate start with the same key, duplicate job delivery); failure injection (storage unavailable → 503 without cached fallback; a lost `Complete` response → the row stays `completing` and is reconciled with `HeadObject`; queue publish failure → reconciler/outbox repairs; the `pg-boss` spike conditions of TD-05); channel-isolation tests (TD-12); reaper tests (expired upload aborted, stale claim resolved); all run inside the container per `nestjs-project/CLAUDE.md`.

**References:** `nestjs-project/CLAUDE.md` and README (test database section); E2, E3; `.claude/skills/testing-guide-nestjs-project`.

**Decision:** _[pending]_

---

## TD-16: Docker Compose topology and environment contract for storage and worker

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)"

**Context:** *Problem:* make the storage service and the worker reproducible with Docker Compose and define the canonical environment keys shared by the Joi schema, `compose.yaml` and `.env.example` (a cross-component contract). *Facts:* `nestjs-project/compose.yaml` already runs `nestjs-api`, `db` (with a health check) and `mailpit`; the frontend stack is separate with no shared network and is out of scope here. The pinned MinIO needs: a published port for the S3 endpoint (presigned URLs use the published host), a named volume for `/data` (persistence verified across a restart), a health check on `/minio/health/ready` (the official release image bundled a static `curl`; our image must provide one too), **server-level CORS** through `MINIO_API_CORS_ALLOW_ORIGIN` (bucket-level `PutBucketCors` → 501; the server-level setting echoed the allowed origin, exposed `Etag` and answered preflights; other origins received no `Access-Control-Allow-Origin`), and **no reliance on `mc`** (its official distribution on `dl.min.io` is covered by the same 410 notice).

**Options:**

### Option A: Extend `nestjs-project/compose.yaml` with `minio` (custom build) and `worker` services
- New services in the existing backend Compose file; internal endpoint `http://minio:9000`, public endpoint `http://localhost:9000` (published port); `depends_on` with `service_healthy`; the application creates the bucket at startup (idempotent `CreateBucket`).
- **Pros:** matches the current structure; one `docker compose up`; the frontend is out of scope, so no cross-stack networking is needed.
- **Cons:** one larger Compose file; the worker and API share environment definitions (mitigated with YAML anchors/`env_file`).

### Option B: Split infrastructure into a separate Compose file with profiles/`include`
- **Pros:** infra vs app separation; selective startup.
- **Cons:** more files and commands for a small system; the existing convention is one Compose file per subproject.

### Option C: A root-level Compose file orchestrating both subprojects on a shared network
- **Pros:** the future client could reach storage by service name.
- **Cons:** reopens the Docker-topology question deliberately deferred by `next-frontend-config-base/TD-03`; unnecessary while the frontend is out of scope.

**Recommendation:** Option A — the smallest change that makes storage and worker reproducible, consistent with the existing per-subproject Compose files.

**Trade-offs and risks:** MinIO's console port is optional and should not be published by default; root credentials come from `.env` (never defaults in tracked files); the health check must be real (a `curl` in the image); the published S3 port is the only new host exposure (local/academic use only, TD-03); the bucket-at-startup choice avoids `mc` but couples bootstrap to the application.

**Implementation impact:** canonical environment keys (names only, with Joi validation, `compose.yaml` and `.env.example` kept in sync, empty or placeholder values in tracked files): `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_API_CORS_ALLOW_ORIGIN`, `MAX_UPLOAD_BYTES`, `UPLOAD_PART_SIZE_BYTES`, `PRESIGN_TTL_SECONDS`, `UPLOAD_EXPIRY_HOURS`, worker limits (concurrency, job timeout, probing bounds), and the test-only bucket/guard keys of TD-15; the `worker` service uses an image target with FFmpeg, resource limits and no published ports.

**References:** `nestjs-project/compose.yaml`; MinIO health endpoints (verified on the pinned build, E1; MinIO docs page https://docs.min.io/community/minio-object-store/operations/monitoring/healthcheck-probe.html); `phase-01-configuracao-base/TD-01..TD-04`.

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Large-file upload protocol and transport | A (multipart, per-part presigned URLs; direction approved by the brief) | _[pending]_ |
| TD-02 | Backend | Upload resumability, completion and cross-system consistency | A (client-recorded manifest verified against paginated `ListParts`; PostgreSQL business state; `HeadObject`/reconciliation for ambiguity; approved with adjustments) | _[pending]_ |
| TD-03 | Backend | S3-compatible object storage server (MinIO) | A (pinned MinIO release from the GitHub asset, SHA-256-verified image; local/academic only) | _[pending]_ |
| TD-04 | Backend | S3 client library and endpoint/signing model | A (AWS SDK v3, internal + public endpoints; direction approved by the brief) | _[pending]_ |
| TD-05 | Backend | Background job queue and job-loss prevention | A (`pg-boss`), conditional on the planning spike; fallback = durable outbox/reconciliation, no silent Redis | _[pending]_ |
| TD-06 | Backend | Media worker topology and responsibilities | A (second entrypoint, separate Compose service) | _[pending]_ |
| TD-07 | Backend | FFmpeg/ffprobe toolchain, validity rules and limits | A (system binaries via `spawn`, no shell; MP4/H.264/optional AAC only; URL-free logs) | _[pending]_ |
| TD-08 | Backend | Processing input access and scratch storage | A (read over HTTP), escalate to C if needed | _[pending]_ |
| TD-09 | Backend | Video lifecycle state machine and failure handling | A (orthogonal publication and processing status, compare-and-set) | _[pending]_ |
| TD-10 | Backend | Unique public video identifier and storage keys | A (random base62 + unique index + bounded `ON CONFLICT` retry) | _[pending]_ |
| TD-11 | Backend | HTTP streaming and download delivery | A (authorize → presigned GET → Range directly on storage); API proxy = future alternative | _[pending]_ |
| TD-12 | Backend | Authorization, ownership by channel and isolation | A (owner-only until published; owner-only download; one policy function) | _[pending]_ |
| TD-13 | Backend | Upload validation, abuse controls and untrusted files | A (layered controls) | _[pending]_ |
| TD-14 | Backend | Orphan resource cleanup and reconciliation | A (scheduled reaper/reconciler) | _[pending]_ |
| TD-15 | Backend | Test strategy for storage, queue, worker and API contract | A (real services with isolation guards; no frontend) | _[pending]_ |
| TD-16 | Repo-wide | Docker Compose topology and environment contract | A (extend `nestjs-project/compose.yaml`) | _[pending]_ |
