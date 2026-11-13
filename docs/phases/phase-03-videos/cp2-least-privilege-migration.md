# CP2 — Least-privilege migration of the main environment and gate re-validation

**Date:** 2026-11-12 · **Branch:** `feature/phase-03-videos` · **Decisions:** `phase-03-videos/TD-03`, `TD-04`, `TD-15`, `TD-16` (revisions of 2026-11-12, including "evaluator setup") · **Procedure:** `migration-least-privilege.md` §4.

_Evidence only — the historical gate evidence (`gate-02-minio.md`, `gate-04-05-completion.md`, `gate-06-media.md`, `gate-07-08-delivery.md`) is kept unchanged; the re-validation below is new evidence under the new credentials and awaits human review. No secret value appears here or in any log used._

## 1. Recovery rehearsal (before touching the main environment)

Isolated replica (`streamtube-rb`, other ports), built at `c5adff0` — the main environment's pre-migration layout (root pair in `.env`, bucket created by the old startup) — seeded with a sentinel object, 3 abandoned multipart uploads and a sentinel database.

| Step | Result |
|---|---|
| Migration to `58e0899`: prepare-only, provisioning ×2 | first run created 14 (7 policies, 7 identities), second run 0 |
| **Simulated failure** (API identity secret no longer matched MinIO) | recreated API failed closed (`BucketUnavailableError`) — no root fallback; worker kept running; data intact |
| **Recovery A — roll-forward** (credential files from the pre-migration backup + setup) | API and worker up; `verify.sh` **13/13 PASS** |
| Second simulated failure → **Recovery B — restore** (code + Compose at `c5adff0`, `.env` from the backup) | dry run: only `nestjs-api` and `worker` recreated; API answering, worker started, restored API authenticates to storage (HeadBucket OK) |
| Data in every state | operational bucket, sentinel object, sentinel database identical to the baseline; **0/3** pre-existing sessions missing (only `streamtube_test`, created by the verification itself, was new) |

## 2. Preflight (main environment, read-only)

| Check | Result |
|---|---|
| Credential files | 7 files in `<repo>/.local/secrets/`, git-ignored, untracked, outside the bind mount, ACL owner-only |
| MinIO root preserved | `minio.env` and `provision.env` hold exactly the root pair of the running MinIO (compared, not printed) |
| Separation | 7 distinct identity IDs, none equal to root; `api.env` = API + delivery, `worker.env` = worker, `test-*.env` = the three test identities, `maintenance.env` = maintenance only |
| Migrations | none pending (4/4 applied) — and none changed since `c5adff0` |
| Compose | `config --quiet` valid for `compose.yaml` and `compose.test.yaml` |
| Dry run | `up -d`: only `nestjs-api` and `worker` would be recreated |
| Recovery files | `.local/pre-cp2/{.env,secrets/}` — byte-identical copies (1 + 7 files), owner-only |
| Destructive commands | none in `setup`/`verify` (no `down -v`, `volume rm`, `mc rb`, `DROP DATABASE`) |
| Backup dump | `streamtube-pre-baseline.dump` — SHA-256 `7eaf1dcd…24ada` matches, host and container copies |

## 3. Migration

| Step | Result |
|---|---|
| Baseline | buckets `streamtube-videos` 0 objects, `streamtube-videos-test` 0 objects + **47** sessions (keys recorded); 0 MinIO users; databases `postgres`, `streamtube`, `streamtube_backup_verify`, `streamtube_test`; dev rows users=1 channels=0 videos=0 migrations=4; `streamtube_backup_verify` 5 tables, 8 083 123 bytes |
| Provisioning #1 | 7 policies + 7 identities created; both buckets kept; post-write verification: buckets present, every identity bound to its own policy |
| Provisioning #2 | **0** created (idempotent) |
| `./scripts/setup.sh` | credential files kept; legacy credential lines moved out of `.env` (owner-only backup); migrations: none pending; **only `nestjs-api` and `worker` recreated** — `minio`, `db`, `mailpit` kept their container IDs and uptime |
| Start | API answering (startup HeadBucket with the API identity); worker "Video worker started" (queue connected) |

Provisioned policies (content-addressed): `streamtube-api-158d08a8`, `streamtube-worker-d598db43`, `streamtube-delivery-07f8d6f2`, `streamtube-test-api-071fe122`, `streamtube-test-worker-58aaa396`, `streamtube-test-delivery-e0627303`, `streamtube-test-maintenance-f0e67906` — one identity bound to each.

## 4. Verification on the main environment

| Run | Result |
|---|---|
| `./scripts/verify.sh` | **13/13 PASS** — health; credential names per container (API: API + delivery; worker: worker; `test-api`/`test-worker`: the three test identities; mounted `.env`: none); Git hygiene; permission matrix + bucket verification 76/76; upload/completion/Range/download e2e 19/19; FFmpeg processing 32/32 |
| `./scripts/verify.sh --full` | **15/15 PASS** — `npm test` 596 passed (32 skipped = the FFmpeg suites, executed in `test-worker`), `test:e2e` 92/92, `test:media` 113/113, `tsc --noEmit` 0, eslint 0 errors (1 known warning) |

## 5. Gate re-validation under the new identities (2026-11-12)

All suites in the ephemeral test containers (`test-api`, `test-worker`), restricted test identities, `S3_TEST_BUCKET`, `DB_TEST_NAME`, `PGBOSS_TEST_SCHEMA`. Gate-specific runs: integration 6 suites / **122 passed**, e2e 3 suites / **30 passed**, media 2 suites / **32 passed**, **0 failed**.

| Gate | Re-validation evidence |
|---|---|
| 2 — MinIO | running image `sha256:080888beaa5d` (`RELEASE.2025-09-07T16-13-09Z`), process user `minio`, `health/ready` 200, CORS preflight from `MINIO_API_CORS_ALLOW_ORIGIN` → 204 with `Access-Control-Allow-Origin`, foreign origin → none; container not recreated |
| 4 — ambiguous completion, identity proof | "lost Complete response keeps completing; the repeated complete proves the object and moves to uploaded"; missing/foreign binding refused as `UPLOAD_INVALID`, object retained, no `DeleteObject`, no job; own binding + wrong size deleted after identity proof; e2e 2.1 `lost-complete-response-stays-completing` |
| 5 — concurrency | "five concurrent completions → one transition, one job, no error"; e2e 4.1 `five-concurrent-http-completions`; "two deliveries leave one thumbnail and a single transition to ready" |
| 6 — real media | 9 accepted H.264 fixtures with duration/metadata, HEVC/MP3/4:4:4/MKV-as-MP4/random/text/truncated rejected, duration ceiling, ffprobe timeout, thumbnail extraction — on FFmpeg 7.1.5 in `test-worker`, worker identity |
| 7 — expiry and renewal | "403 after `expires_at`, and a renewed URL resumes the Range from the same byte"; e2e 1.3 `expiry-and-renewal`; renewal keeps authorization (other user 404) |
| 8 — HTTP Range | 206 with `Content-Range`/`Content-Length`/`Accept-Ranges` and exact bytes, mid-file and open-ended ranges, 200 for an invalid range, 416 unsatisfiable; e2e 1.2; delivery URLs signed by the delivery identity only |
| Reconciler + reservations | reservation kept while a session is open (missing/divergent binding), expired uploads expire only after the session is gone, stale claims resolved through the proof, storage unreachable → nothing changes; worker identity lists/aborts API sessions and cannot upload/complete them |

## 6. After-migration inventory

| Item | Before | After |
|---|---|---|
| `streamtube-videos` objects / sessions | 0 / 0 | 0 / 0 |
| The 47 abandoned sessions in `streamtube-videos-test` | 47 | **47/47 present** |
| `streamtube-videos-test` objects / sessions in total | 0 / 47 | 241 / 165 — the extra ones are the test runs' own keys (suites never clean; no cleanup was run) |
| MinIO users / custom policies | 0 / 0 | 7 / 7 |
| Databases | 4 | the same 4 |
| Dev rows (users/channels/videos/migrations) | 1/0/0/4 | 1/0/0/4 |
| `streamtube_backup_verify` | 5 tables, 8 083 123 B | identical |
| Backup dump | SHA-256 match | SHA-256 match |
| `minio`, `db`, `mailpit` containers | — | not recreated, not restarted |

## 7. Limitations

- `setup.sh`/`verify.sh` were executed under Git Bash on Windows only; a native Linux/macOS run was not possible here (WSL without Docker Desktop integration).
- The provisioning image built by the setup gets a local image ID different from the one recorded in TD-03 (`sha256:b38b632352ee…`); the `mc` binary is still verified by its SHA-256 at build time.
- The test bucket accumulates the suites' objects and sessions (by design, TD-15); cleanup is the explicit, guarded maintenance wrapper, never automatic.
- Gate 3 (10 GiB) is not part of CP2 and stays PENDING.
