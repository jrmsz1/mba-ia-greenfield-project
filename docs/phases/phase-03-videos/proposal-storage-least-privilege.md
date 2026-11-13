# Proposal — Least-privilege storage identities (before SI-03.17)

**Status:** DECIDED — the direction of this proposal is recorded as Append revisions (Decision A unchanged) of TD-03, TD-04 and TD-16 (`/decide`, 2026-11-12, TD-16 with the preflight adjustment) and of TD-15 and TD-16 (`/plan-resolve`, 2026-11-12: IC-4, IC-5, AMB-4); `/plan-validate 03` is clean (26 issues resolved) and the plan and the four Test Specs were synced on 2026-11-12. **Nothing is implemented yet** (§5): code, Compose, credentials, buckets, objects, users and policies of the existing environment are unchanged.

## 1. Inventory — S3 operations actually used (code at `c5adff0`)

| `StorageService` method | S3 operation | SDK client | API | Worker |
|---|---|---|---|---|
| `createMultipartUpload` | CreateMultipartUpload (+ `upload-binding` metadata) | `singleAttempt` | upload start | — |
| `presignUploadPart` | **signs** UploadPart | `publicSigner` | part URLs | — |
| `listParts` | ListParts | `internal` | status/resume, completion, recovery, cleanup | reconciler |
| `completeMultipartUpload` | CompleteMultipartUpload | `singleAttempt` | completion | — |
| `abortMultipartUpload` | AbortMultipartUpload | `internal` | cancel/cleanup | reconciler |
| `listMultipartUploads` | ListMultipartUploads | `internal` | cleanup, session check | reconciler |
| `headObject` | HeadObject | `internal` | proof, recovery | processing, reconciler |
| `deleteObject` | DeleteObject (identity-proven, re-read first) | `internal` | recovery | reconciler |
| `putObject` | PutObject | `internal` | — | thumbnail |
| `presignInternalGet` | **signs** GetObject (internal endpoint) | `internal` | — | ffprobe/ffmpeg input |
| `presignGet` | **signs** GetObject (+ response-content-disposition) | `publicSigner` | playback/download | — |
| `BucketBootstrapService` | HeadBucket + CreateBucket at boot | `internal` | yes | yes |

## 2. Spike — evidence (isolated pinned MinIO, 2026-11-12)

**Isolation.** The spike used a separate container of the **same pinned server image**:

- image `sha256:080888beaa5d320726fa63ac5589129eb2a3d22d88d3fb6a623e28f74dafd656`, `minio version RELEASE.2025-09-07T16-13-09Z`;
- its own network `streamtube-spike-net`, `tmpfs` data, and random throwaway root and identity secrets (never printed, never written to the repo).

Afterwards the container and network were removed and the secrets file deleted. The Compose stack (`db`, `mailpit`, `minio`, `nestjs-api`), `streamtube_backup_verify` and the dump were untouched.

**Admin client.** `minio/mc` (Docker Hub, "repository does not exist") and `quay.io/minio/mc` (401 for every tag, including `latest`) **cannot be pulled**, so no upstream image can be pinned by digest. The ephemeral admin image is therefore built the same way as the server image (`nestjs-project/docker/storage-provision/Dockerfile`):

- base `debian:12-slim@sha256:734a72b3…` (pinned by digest);
- the `mc` release asset `RELEASE.2025-08-13T08-35-41Z`, verified by SHA-256 `01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891`;
- non-root user;
- built image `sha256:b38b632352ee75b12d3072e648a78c6a68ddc4b484cb0f7822ea3b09d9074ef2`, reporting `mc version RELEASE.2025-08-13T08-35-41Z`. A tampered checksum fails the build (exit 1).

**Provisioning** (`provision.sh`, `policies/{api,worker,delivery}.json`). Root credentials are passed only through `MC_HOST_admin`, never as argv. The script works in two phases:

- *Phase 1* validates everything before any write. An existing user bound to a different policy stops the run with `FAIL-CLOSED … (nothing changed)`.
- *Phase 2* creates only what is missing: the bucket, policies named by content (`streamtube-<role>-<sha8>`, never overwritten), and users plus their attachment. An existing user's secret is never touched. Nothing is deleted or recreated.

| Check | Result |
|---|---|
| Fresh provision | bucket + 3 policies + 3 users created |
| Second run | pure no-op (everything "exists/kept") |
| Conflict (worker policy content changed) | `FAIL-CLOSED`, exit 1, policy list byte-identical before/after |
| `mc admin user list` / `mc admin info` with the API identity | `Access Denied` / `Access Denied` |

**Allow/deny matrix** (`spike/matrix.mjs`, the project's `@aws-sdk/client-s3`; full output in `spike/matrix-result.txt`, no secrets). Run twice (provisioned and then fresh): **66 cases, 64 as expected; the 2 deviations are explained below.**

| Operation | API | Worker | Delivery |
|---|---|---|---|
| HeadBucket (configured bucket) | ALLOW | ALLOW | DENY |
| CreateBucket (other / configured) | DENY / DENY | DENY / DENY | DENY / DENY |
| ListBuckets | ALLOW* | ALLOW* | DENY |
| ListObjectsV2 (bucket) | ALLOW | ALLOW | DENY |
| CreateMultipartUpload (+ binding metadata) | ALLOW | DENY | DENY |
| UploadPart (direct) / via a URL this identity signed | ALLOW / ALLOW | DENY / DENY | DENY / DENY |
| ListParts / ListMultipartUploads | ALLOW / ALLOW | ALLOW / ALLOW | DENY / DENY |
| CompleteMultipartUpload | ALLOW | DENY | DENY |
| AbortMultipartUpload | ALLOW | ALLOW | DENY |
| HeadObject / GetObject (original) | ALLOW | ALLOW | ALLOW |
| GetObject (thumbnail) | DENY | DENY | DENY |
| Presigned GET original + `Range: bytes=0-1023` | 206 | 206 | **206**, `Content-Range bytes 0-1023/262144`, `Content-Disposition` honored, `X-Amz-Credential=streamtube-delivery/…` |
| PutObject original (plain PUT) | **ALLOW** (limitation) | DENY | DENY |
| PutObject thumbnail | DENY | ALLOW | DENY |
| PutObject outside `videos/` | DENY | DENY | DENY |
| DeleteObject original | ALLOW | ALLOW | DENY |
| **Cross-identity** on a session opened by the API | — | ListParts ALLOW, Abort ALLOW, UploadPart DENY, Complete DENY | ListParts DENY |
| Part URL signed by the API, replayed as a plain PUT (uploadId/partNumber stripped) | DENY (signature mismatch) | | |

\* **Deviation, explained:** MinIO answers `ListBuckets` for any identity holding a permission on some bucket and **filters** the result. Verified: with a second bucket created by root, root sees `["spike-videos","unrelated-private-bucket"]` while API and worker see only `["spike-videos"]`. No foreign bucket name leaks.

## 3. Real limitations of the permission model (documented, accepted by design)

1. **`s3:PutObject` is one action** for CreateMultipartUpload, UploadPart, CompleteMultipartUpload **and** a plain PUT. The API identity can therefore technically PUT an original; the code never does. A part URL cannot be turned into a plain PUT (proven: DENY).
2. **`s3:ListBucket` on the bucket** (needed for HeadBucket) also allows ListObjectsV2 of the bucket for API and worker, i.e. object keys (`videos/<uuid>/…`), never contents they are not granted.
3. **`ListBuckets`** is answered as filtered (see above); it cannot be denied separately without removing all bucket-level grants.
4. **The worker can delete originals** (reconciler, identity-proven only, after a re-read). The policy cannot express "only with this upload's binding"; that guarantee stays in code (Gate 4 rule).
5. **An existing user's secret is never rotated** by provisioning (it cannot read it). Rotation is a separate, explicit operation.
6. Prefix scoping uses `videos/*/original` and `videos/*/thumbnail.jpg`, where `*` also matches `/`, so the key layout of TD-10 must stay as it is.

## 4. Differences from the original proposal

| Topic | Original proposal | Revised (after the review and the spike) |
|---|---|---|
| `mc` location | inside the pinned **server** image | **separate ephemeral admin image**; the server image is unchanged, so Gate 2 needs no re-run for the server |
| `mc` provenance | pinned by checksum | the upstream images are not pullable; the admin image is built from the SHA-256-verified release asset on a digest-pinned base, and its own image digest is recorded |
| Bucket creation | kept at application boot (`s3:CreateBucket` granted to API/worker) | moved to provisioning; API/worker **only verify** (HeadBucket, fail fast); **no `s3:CreateBucket`** for any operational identity (proven DENY) |
| Provisioning conflicts | tolerate "already attached" | validate everything first; any conflict stops with no write; policies are content-addressed and never overwritten |
| Multipart action names | assumed | **proven** on the pinned build (ListMultipartUploadParts, AbortMultipartUpload, ListBucketMultipartUploads, PutObject) |
| Limitations | PutObject only | PutObject, ListBucket/ListObjectsV2, the filtered ListBuckets, worker delete, no secret rotation, key-layout dependency |

## 5. Future work — NOT implemented yet

Ordered as the plan's "Revisão 2026-11-12" blocks (SI-03.2, SI-03.3, SI-03.4, SI-03.12, SI-03.16); all of it is a prerequisite of SI-03.17 / Gate 3.

| # | Work item | Plan reference | Decision |
|---|---|---|---|
| 1 | Operational **and** test provisioning: `S3_BUCKET` + `S3_TEST_BUCKET`, per-role policies rendered per bucket, production identities on `S3_BUCKET`, test identities (`S3_TEST_API_*`, `S3_TEST_WORKER_*`, `S3_TEST_DELIVERY_*`) on `S3_TEST_BUCKET`, maintenance policy limited to `S3_TEST_BUCKET`; preflight rejecting root-equal IDs, ID collisions and `S3_TEST_BUCKET = S3_BUCKET` before any write | SI-03.3 R2 | TD-03, TD-15 (IC-4), TD-16 (IC-4, IC-5) |
| 2 | Real identities and policies created in the main environment (secrets generated locally in the git-ignored `.env`) | SI-03.3 R2–R3 | TD-04, TD-16 |
| 3 | Controlled Compose migration: per-service credentials, `MINIO_ROOT_*` only on `minio`, read-only inventory before/after, rollback by restoring the previous `.env`; no bucket/object deleted or recreated; dev DB, `streamtube_backup_verify` and the dump untouched | SI-03.3 R1, R3; SI-03.12 R1 | TD-16 |
| 4 | S3 client/signer split: `partSigner` (API identity), `deliverySigner` (delivery identity), worker internal GET with the worker identity; `BucketBootstrapService` → HeadBucket only, fail fast; Joi without `MINIO_ROOT_*`, delivery keys required on the API, no test-key fallback | SI-03.2 R1–R3; SI-03.4 R1–R2; SI-03.16 R1 | TD-03, TD-04, TD-16 |
| 5 | Test harness: `S3_TEST_*` mapped only in the explicit test context; `emptyTestBucket`/`ensureBucket` removed from every suite hook; tests isolate objects by their own `videos/<uuid>/…` keys; no empty-bucket assumption | SI-03.4 R3 | TD-15 (IC-5, AMB-4), TD-16 (IC-5) |
| 6 | External test-maintenance container (`S3_TEST_MAINTENANCE_*` only): positive target verification, then object deletion/multipart abort in `S3_TEST_BUCKET`; on demand, before/after suite runs, never concurrently, never a Compose service nor inside `nestjs-api`/`worker` | SI-03.4 R4 | TD-15 (AMB-4), TD-16 (IC-4) |
| 7 | Permission regression (the spike matrix ported to `S3_TEST_BUCKET` with the restricted test identities, never maintenance or root) and re-run of the affected gates: 4/5 (completion, API identity), 6 (worker read), 7/8 (delivery signer), the SI-03.15 reconciler suite; Gate 2 needs no re-run (server image unchanged); then SI-03.17 / Gate 3 | SI-03.4 R5; SI-03.16 R2; SI-03.17 prerequisite | TD-04, TD-15 |

The provisioning scripts in `nestjs-project/docker/storage-provision/` are still the spike version (production bucket only); extending them to the test bucket and the preflight is item 1 and has not been done.

## 6. Recorded decisions (authoritative text lives in the decisions doc)

The texts proposed here were recorded, with the user's adjustments, in `docs/decisions/technical-decisions-phase-03-videos.md`:

- **TD-03** (2026-11-12) — least-privilege provisioning: unchanged server image, ephemeral admin `mc` container (full image/base/release/checksum identifiers), idempotent and fail-closed, provisioning creates the bucket, HeadBucket-only processes, no secret rotation.
- **TD-04** (2026-11-12) — three identities (API, worker, read-only delivery), signer split, no bucket creation or admin API, and the proven limitations of §3.
- **TD-15** (2026-11-12, IC-4) — test bucket provisioned and validated; tests use the TD-04 profiles as test-only identities scoped to `S3_TEST_BUCKET`; fixture preparation and destructive cleanup under a dedicated test-maintenance identity outside API and worker; fail-closed target verification; negative-permission tests never use the maintenance identity.
- **TD-15** (2026-11-12, IC-5/AMB-4) — the maintenance mechanism is an ephemeral on-demand container run before/after suites, never concurrently; in-container suites do no storage cleanup, only verify the target, and isolate objects by unique keys; DB and queue-schema resets unchanged.
- **TD-16** (2026-11-12) — per-process credentials (`S3_API_*`, `S3_WORKER_*`, `S3_DELIVERY_*`), `MINIO_ROOT_*` only on `minio` and provisioning, API/worker validate only their own credentials, the provisioning/preflight rejects any operational identity equal to the administrative one.
- **TD-16** (2026-11-12, IC-4) — `S3_TEST_MAINTENANCE_*`, separate from every other identity, never injected into API/worker, never a fallback.
- **TD-16** (2026-11-12, IC-5) — `S3_TEST_API_*`, `S3_TEST_WORKER_*`, `S3_TEST_DELIVERY_*`, mapped only in the explicit test context, never read by production startup; collisions rejected by provisioning/preflight.

## 7. Artifacts (uncommitted, for review)

- `nestjs-project/docker/storage-provision/Dockerfile`: ephemeral admin `mc` image.
- `nestjs-project/docker/storage-provision/provision.sh`: idempotent, fail-closed provisioning.
- `nestjs-project/docker/storage-provision/policies/{api,worker,delivery}.json`: bucket-templated policies.
- `nestjs-project/docker/storage-provision/spike/matrix.mjs` + `matrix-result.txt`: allow/deny matrix and its output.
