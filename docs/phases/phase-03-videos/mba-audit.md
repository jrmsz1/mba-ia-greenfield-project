# Phase 03 — MBA audit matrix (CP4)

**Date:** 2026-11-12 · **Branch:** `feature/phase-03-videos` (from `dev`, not merged; nothing committed to `main`) · **HEAD audited:** `c1d7416` plus the CP4 docs commit.

_Criteria source: `docs/project-plan.md` → Phase 03 (capabilities, deliverables, attention points), the root `CLAUDE.md` (Definition of Done, Git Flow, working principles) and the plan pipeline artifacts. The official MBA brief, with its automatic-fail list, is **not** in the repository. The automatic-fail column below lists the usual causes checked explicitly; it is not the official list. A criterion is PASS only with executed or committed evidence._

## 1. Definition of Done (executed 2026-11-12, CP4)

| Check | Command | Result |
|---|---|---|
| Full regression | `./scripts/verify.sh --full` | **RESULT: PASS** — 15/15 |
| Unit + integration | `npm test` in `test-api` | 596 passed, 32 skipped (the FFmpeg suites, executed below), 0 failed |
| E2E | `npm run test:e2e` in `test-api` | 92/92 passed |
| Media (real FFmpeg 7.1.5) | `npm run test:media` in `test-worker` | 113/113 passed |
| Type check | `npx tsc --noEmit` | exit 0 |
| Lint (check) | `npx eslint "{src,apps,libs,test}/**/*.ts"` | 0 errors, 1 known warning (`no-unsafe-argument`, `auth.service.integration-spec.ts`) |
| Lint (DoD command) | `npm run lint` in `nestjs-api` | exit 0; **no file changed** (`git status` identical before and after `--fix`) |
| Migrations | `migration:show` | 4/4 applied, none pending |
| Compose | `docker compose config --quiet` (main and main + test) | valid |
| Runtime | verify.sh | PostgreSQL accepting connections, MinIO ready, API answering, worker running and connected to the queue |
| Credential isolation | verify.sh | `nestjs-api`: API + delivery only; `worker`: worker only; `test-api`/`test-worker`: restricted test identities only; mounted `.env`: no credential; no secret file tracked by Git |

No test was skipped beyond the FFmpeg suites, which the API image cannot run by design (TD-06) and which ran in full in `test-worker`. No mock was added and no assertion was relaxed in CP4.

## 2. Traceability matrix

| # | Criterion | Implementation | Evidence | Status |
|---|---|---|---|---|
| 1 | Storage service for videos and thumbnails | Pinned MinIO (`docker/minio`, `RELEASE.2025-09-07T16-13-09Z`), `src/storage/`, least-privilege identities (TD-03, TD-04, TD-16) | `gate-02-minio.md`; `cp2-least-privilege-migration.md`; verify.sh "MinIO is ready" | PASS |
| 2 | Background processing (queue) | pg-boss in PostgreSQL (`src/queue/`), transactional publish with the state change (TD-05); separate `worker` service (TD-06) | Gate 1 `spike-pgboss.md`; Gate 3 criterion 10 (job only after completion); verify.sh "worker running and connected to the queue" | PASS |
| 3 | Upload of up to 10 GB without performance impact | Multipart direct to MinIO by presigned URLs; the body never goes through the API (TD-01, TD-13) | Gate 3 `verification-10gib.md`: exactly 10 737 418 240 B, API RSS variation 21 MiB, 10 GiB + 1 B refused | PASS (limitations in §4) |
| 4 | Resumable upload | `GET /videos/:id/upload` lists uploaded/missing parts; part URLs re-issued (TD-01, TD-02) | Gate 3 criterion 5: interrupted after 80 parts, exactly the 80 missing parts sent; e2e `videos-upload-parts` | PASS |
| 5 | Automatic draft pre-registration | `POST /videos` creates the row `publication = draft`, `processing_status = uploading` | Gate 3 criterion 3; e2e `videos-start-and-status` | PASS |
| 6 | Automatic processing: duration and metadata | Worker probe with ffprobe, media rule (TD-07), Range reads (TD-08) | Gate 6 `gate-06-media.md` (real fixtures); Gate 3 criterion 11 (`duration_seconds: 3600`, `media_metadata`) | PASS |
| 7 | Automatic thumbnail | Worker extracts `videos/<uuid>/thumbnail.jpg` | Gate 6; Gate 3 criterion 11 (thumbnail of 199 363 B) | PASS |
| 8 | Unique, short URL per video | `public_id` varchar(11), unique constraint, retry on collision (TD-10) | migration `CreateVideos`; `public-id.generator.integration-spec.ts` | PASS |
| 9 | Streaming without a full download | `GET /videos/:id/playback-url` → presigned URL; HTTP Range served by MinIO (TD-11) | Gates 7–8 `gate-07-08-delivery.md`; Gate 3 criterion 13 (206 on the first and last KiB of 10 GiB, byte-identical) | PASS |
| 10 | Download | `GET /videos/:id/download-url`, `Content-Disposition: attachment` (RFC 6266) | Gate 8; Gate 3 criterion 14 | PASS |
| 11 | Video ↔ channel relation in the database | `videos.channel_id` FK → `channels.id` (`ON DELETE RESTRICT`), indexes per channel; ownership policy (TD-12) | migration `1794453245701-CreateVideos.ts`; Authorization Matrix in the plan; e2e 404 for another user | PASS |
| 12 | Authorization | All endpoints authenticated; non-owner → 404; playback/download only `ready` (else 409) | Authorization Matrix; e2e suites (92/92) | PASS |
| 13 | Upload completion consistency | Completion proof, ambiguous completion and concurrency (TD-02, TD-09) | Gates 4–5 `gate-04-05-completion.md` | PASS |
| 14 | Storage growth / orphan resources | Reconciler for expired and stale uploads, quota per owner (TD-13, TD-14); test-bucket cleanup is an explicit guarded tool | `video-reconciler.worker.integration-spec.ts`; Gate 3 criterion 7 | PASS |
| 15 | Compose with storage, queue and worker | `nestjs-project/compose.yaml` (`nestjs-api`, `worker`, `minio`, `db`, `mailpit`) + `compose.test.yaml` (ephemeral `test-api`, `test-worker`) | `config --quiet` valid; verify.sh health checks | PASS |
| 16 | Simple evaluator execution | `scripts/setup.sh`/`.ps1` (one command), `scripts/verify.sh`/`.ps1` (quick and `--full`) | CP2 rehearsal and migration; this CP4 run | PASS on Windows + Git Bash; **native Linux/macOS not executed** (see §3) |
| 17 | Green tests at every level | Unit, integration, e2e, media | §1 | PASS |
| 18 | Definition of Done (root `CLAUDE.md`) | — | §1 | PASS |
| 19 | Plan pipeline artifacts | `context.md`, `validation.md` (`status: clean`), `phase-03-videos.md` with Data Model, API Contracts, Authorization Matrix, Error Catalog, Events/Messages, Dependency Map, Deliverables; 16 TDs in `docs/decisions/technical-decisions-phase-03-videos.md` | files present | PASS |
| 20 | Step Implementations and progress | 17/17 SIs completed | `progress.md` | PASS |
| 21 | Verification gates 1–8 | — | `progress.md` gates table: Gates 1, 3, 4, 5, 6, 7, 8 approved by the user; Gate 2 recorded as "PASS — evidence executed" with no explicit approval line (re-validated in CP2, which the user approved) | PASS (Gate 2: approval wording to confirm) |
| 22 | CLAUDE.md / README / `.env.example` consistent | Fixed in CP4 (§5) | this commit | PASS |
| 23 | Git Flow | Feature branch from `dev` (`dev` is an ancestor, 45 commits ahead, 0 behind); no commit to `main`; no push/merge/rebase | `git merge-base --is-ancestor dev HEAD` | PASS |
| 24 | Secrets outside Git | `.local/` git-ignored, owner-only; `.env.example` with no credential values; `DB_TEST_SERVER_ID=` empty | verify.sh "no secret file tracked by Git" | PASS |
| 25 | Frontend for Phase 03 | Not in the Phase 03 scope (TD-15 "no frontend"; screens arrive in Phases 04–05) | `project-plan.md` Phase 03; TD-15 | N/A |

**Summary:** PASS 24 · PENDING 0 · FAIL 0 · N/A 1. Two items carry a recorded caveat: #16 (native Linux/macOS not run) and #21 (Gate 2 approval wording).

## 3. Possible automatic-fail causes (checked)

| Cause | Checked | Result |
|---|---|---|
| Failing tests, or tests disabled to pass | full suites, §1 | not present (only the FFmpeg suites skip in `test-api`, and they run in `test-worker`) |
| Project does not start or needs manual configuration | setup + verify scripts | starts with one command on Windows + Git Bash; Linux/macOS **not executed natively** — the main residual risk if the evaluator uses another OS |
| Credentials committed | Git hygiene check, `.env.example` | none tracked |
| Commits directly on `main` | branch lineage | none |
| Required deliverable missing (10 GB upload, processing, streaming, unique URL) | matrix #3, #6–#10 | all present with evidence |
| TypeScript or lint errors | §1 | none (1 known lint warning, accepted baseline) |
| Mandatory documentation missing or contradictory | §5 | contradictions fixed |

## 4. Limitations of the scale proof (Gate 3)

Synthetic but valid MP4 (generated test pattern + sine tone, padded with an ISO BMFF `free` box); container → MinIO transfer inside the Docker VM, not real Internet conditions; memory sampled once per second; the run does not prove intensive transcoding of 10 GiB (Phase 03 only probes, extracts metadata and makes one thumbnail by Range). Details: `verification-10gib.md` §7.

## 5. Documentation inconsistencies fixed in CP4

| File | Before | After |
|---|---|---|
| `CLAUDE.md` (root) | `next-frontend/` "not yet initialized"; Message Queue "(TBD)" | frontend implemented for Phases 01–02; queue = pg-boss on PostgreSQL (TD-05) |
| `docs/diagrams/software-arch.mermaid` | queue technology "TBD" | "pg-boss on PostgreSQL" |
| `README.md` | Phase 03 "Planejada"; no Phase 03 features or endpoints; project tree and stack without videos/storage/queue/worker | Phase 03 completed (backend, not yet merged into `dev`); endpoint table; tree and stack updated |
| `docs/phases/phase-03-videos/progress.md` | `Status: in_progress`; CP2 re-validation "awaiting human review"; SI-03.13 note "Gate 6 awaiting approval"; SI-03.15 note "Error Catalog out of sync" | `Status: completed`; CP2 approval and CP4 closing recorded; the two notes annotated as approved/resolved (original text kept) |

`nestjs-project/CLAUDE.md`, `nestjs-project/README.md` and `.env.example` were reviewed and needed no change. No acceptance criterion was changed retroactively and no technical decision was added.

## 6. Preserved (not touched by CP4)

The 10 GiB object and its thumbnail in `streamtube-videos-test`; the `streamtube-gate3-media` volume; the historical (47) and later multipart sessions; the development database; `streamtube_backup_verify`; the backup dump. No cleanup was run.
