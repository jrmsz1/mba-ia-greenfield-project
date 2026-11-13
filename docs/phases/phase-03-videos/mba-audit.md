# Phase 03 — MBA audit matrix (CP4)

**Date:** 2026-11-12 (CP4), updated 2026-11-13 (CP5; independent evaluation of `main`, §9) · **Branch:** `feature/phase-03-videos` (from `dev`, not merged; nothing committed to `main`) · **HEAD audited:** `c1d7416` plus the CP4 docs commit; CP5 re-audited `f809631` on a clean clone (`evaluator-simulation.md`).

_Criteria source: `docs/project-plan.md` → Phase 03 (capabilities, deliverables, attention points), the root `CLAUDE.md` (Definition of Done, Git Flow, working principles) and the plan pipeline artifacts. The official MBA brief is not in the repository; its automatic-fail criteria, as provided by the user, are checked one by one in §7. A criterion is PASS only with executed or committed evidence._

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
| 16 | Simple evaluator execution | `scripts/setup.sh`/`.ps1` (one command), `scripts/verify.sh`/`.ps1` (quick and `--full`) | CP5 clean clone (`evaluator-simulation.md`): `setup.sh` complete in 102 s with no manual step (run 3, at `f809631`); `verify.sh` 13/13; video flow 12/12 twice. Runs 1–2 failed first: a build defect (fixed, `f809631`) and a host-wide I/O slowdown that outlasted the 2-minute health window | PASS on Windows (Git Bash; PowerShell prepare-only + full verify); **native Linux/macOS not executed** |
| 17 | Green tests at every level | Unit, integration, e2e, media | §1; CP5 clean clone: `npm test` 596/0 failed, `test:e2e` 92/92, `test:media` 113/113. One earlier clone run had 4 AuthService integration failures that did not reproduce twice (cause indeterminate, `evaluator-simulation.md` §3) | PASS (intermittent failure recorded) |
| 18 | Definition of Done (root `CLAUDE.md`) | — | §1 (main environment, CP4); the same commands on the clean clone at `f809631` (CP5) | PASS |
| 19 | Plan pipeline artifacts | `context.md`, `validation.md` (`status: clean`), `phase-03-videos.md` with Data Model, API Contracts, Authorization Matrix, Error Catalog, Events/Messages, Dependency Map, Deliverables; 16 TDs in `docs/decisions/technical-decisions-phase-03-videos.md` | files present | PASS |
| 20 | Step Implementations and progress | 17/17 SIs completed | `progress.md` | PASS |
| 21 | Verification gates 1–8 | — | `progress.md` gates table: all 8 approved by the user (Gate 2 formally on 2026-11-13, covering its evidence and the CP2 re-validation) | PASS |
| 22 | CLAUDE.md / README / `.env.example` consistent | Fixed in CP4 (§5) and CP5 (§8). **Reopened 2026-11-13** by the independent evaluation (§9): consistent, but `CLAUDE.md` had no videos section (module, endpoints, queue/worker, storage). Section added in `nestjs-project/CLAUDE.md` + pointer in the root `CLAUDE.md` (§9.2) | CP4 and CP5 commits; §9 cross-check | PASS (was PASS; reopened and corrected 2026-11-13, §9 — final confirmation on the published version in §9.3) |
| 23 | Git Flow | Feature branch from `dev` (`dev` is an ancestor, 45 commits ahead, 0 behind); no commit to `main`; no push/merge/rebase | `git merge-base --is-ancestor dev HEAD` | PASS |
| 24 | Secrets outside Git | `.local/` git-ignored, owner-only; `.env.example` with no credential values; `DB_TEST_SERVER_ID=` empty | verify.sh "no secret file tracked by Git" | PASS |
| 25 | Frontend for Phase 03 | Not in the Phase 03 scope (TD-15 "no frontend"; screens arrive in Phases 04–05) | `project-plan.md` Phase 03; TD-15 | N/A |

**Summary (after CP5):** PASS 24 · PENDING 0 · FAIL 0 · N/A 1 — unchanged, each still justified by the CP5 evidence. Recorded caveats: #16 (native Linux/macOS not run; on this host the setup failed twice before passing, causes in `evaluator-simulation.md` §4) and #17 (one intermittent AuthService integration failure, cause indeterminate). **2026-11-13 (independent evaluation, §9):** #22 reopened for the missing videos section and corrected; the counts are unchanged. One open point (no `title` column, §9.4) awaits the user's decision and is not counted as PASS.

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

## 7. Automatic-fail criteria (as provided by the user)

| Criterion | Evidence | Result |
|---|---|---|
| Workflow research → planning → implementation | commits in ancestry order (verified with `git merge-base --is-ancestor`): `da85c48` decisions (research, 16 TDs) → `a8fe933`/`52cd49a` context + clean validation → `84aef92` plan → `bc63506` test specs → `4fc0aec` first implementation (SI-03.1) | PASS |
| Plan with SIs and Technical Specifications; `validation.md` clean | `phase-03-videos.md`: 17 SIs, `## Technical Specifications` with Data Model, API Contracts, Authorization Matrix, Error Catalog, Events/Messages, plus Dependency Map and Deliverables; `validation.md` frontmatter `status: clean` | PASS |
| 10 GB upload without the whole file going through the API | Gate 3: 10 737 418 240 B, every part `PUT` to presigned MinIO URLs, API RSS variation 21 MiB; CP5: the part went to `localhost:9300` (MinIO), the API only issued URLs | PASS |
| Real queue, worker and object storage in Compose | `compose.yaml`: `worker`, `minio` (pinned image), pg-boss on `db`; CP5 clean clone: job row in `pgboss.job` (0 → 1), worker processed to `ready`, thumbnail object in MinIO | PASS |
| Tests, tsc and lint green | CP4 main environment: 596 + 92 + 113, tsc 0, eslint 0 errors; CP5 clean clone: the same counts, `tsc` 0, eslint 0 errors (1 known warning) — one intermittent run with 4 AuthService failures, not reproduced twice (§2 #17) | PASS (caveat recorded) |
| No direct commit on `main` | `main` at `8459b2f`; none of the branch's commits is on `main`; branch from `dev` (`dev` is an ancestor); no push, merge or rebase | PASS |
| `CLAUDE.md` consistent | root `CLAUDE.md` (CP4: frontend, queue), `nestjs-project/CLAUDE.md` (CP5: second copy needs its own `COMPOSE_PROJECT_NAME`); commands, ports, credentials and test procedure match what the clean clone executed. 2026-11-13: still consistent, but the videos section was missing; added and cross-checked against the code (§9) | PASS |
| AI foundation preserved (Claude Code) | `.claude/` (6 agents, 17 rules, the plan-pipeline/implement/decide/testing-guide skills, settings), `skills-lock.json`, `CLAUDE.md` at root, `nestjs-project/` and `next-frontend/`, `.mcp.json` (+ example) — all present in the clean clone; `git diff dev..HEAD -- .claude skills-lock.json` is empty (only the documented `CLAUDE.md` fixes changed) | PASS |

## 8. CP5 findings and fixes

| Finding | Action |
|---|---|
| Fresh build emitted `dist/src/main.js` (Gate 3 script inside the build) — API and worker could not start on a clean clone | fixed in `f809631` (`scripts` excluded from `tsconfig.build.json`); verified by the clean-clone setup and the full suites |
| A second copy needs its own `COMPOSE_PROJECT_NAME`, not only other ports | documented in `README.md` and `nestjs-project/CLAUDE.md` |
| The README did not link the 10 GiB report or show its optional command | README "Verificação opcional de 10 GiB" |
| The provisioning image tag `streamtube-storage-provision:local` is shared between copies | recorded (`evaluator-simulation.md` §6); no change — the setup rebuilds it on every run |
| `verify.ps1`/`verify.sh` keep only the last lines of a failing suite, so a first error can be lost | recorded as a limitation; not changed in CP5 |

## 9. Independent evaluation of `main` (2026-11-13)

The published `main` at `2a1e842` was evaluated item by item against the official MBA brief (provided by the user). Every criterion was found met except one documentation gap, and a further data-model point came up during this correction (§9.4). The automatic-fail list (§7) still holds.

### 9.1 Finding — `CLAUDE.md` had no videos section

The brief asks for `CLAUDE.md` updated with a videos section reflecting the module, the endpoints, the queue/worker and the storage.

- **What it had:** the root `CLAUDE.md` named pg-boss and the worker. `nestjs-project/CLAUDE.md` covered the Compose services, credentials and test procedure.
- **What was missing:** neither file described the videos module, its endpoints, the status lifecycle, the queues or the storage layout. The endpoint table existed only in `README.md`.
- **Why the earlier audit missed it:** CP4/CP5 (§2 #22, §7) checked that `CLAUDE.md` was consistent, not that the section existed.
- **Outcome:** criterion #22 was reopened.

### 9.2 Correction (branch `docs/phase-03-evaluator-fix`, documentation only)

- **`nestjs-project/CLAUDE.md`:** new section "Videos (Phase 03)", with modules, endpoints, authorization, upload flow and presigned URLs, status lifecycle, queues and worker, ffprobe/ffmpeg, storage layout, streaming/download, and setup and tests.
- **Root `CLAUDE.md`:** a one-line pointer to that section, so nothing is duplicated.
- **`library-refs.md`:** later evidence added below the original "Not yet proven — TypeORM + pg-boss" note, which is kept as written.

Cross-check of the new section against the code at `05d212a`:

| Condition for PASS | Checked against | Result |
|---|---|---|
| Section present | `nestjs-project/CLAUDE.md` → "Videos (Phase 03)"; root pointer | present |
| Endpoints match the controller | `src/videos/videos.controller.ts`: the 8 route decorators and their `@HttpCode` / `@ApiResponse` (201/200, 200, 200, 200, 200/202, 200, 200, 204) | 8 of 8 match: methods, paths, success codes |
| State machine matches the entity and services | `VIDEO_PROCESSING_STATUSES` / `VIDEO_PUBLICATIONS` (`video.constants.ts`); conditional `UPDATE`s in `video-upload.service.ts`, `video-completion.service.ts`, `upload-recovery.service.ts`, `video-upload-parts.service.ts`, `video-processing.worker.ts`, `video-reconciler.worker.ts` | every documented transition has a writer; no undocumented writer |
| Queues, worker and storage match the implementation | `QUEUES`, `QUEUE_POLICY`, `VIDEO_PROCESS_RETRY`, `RECONCILE_CRON` (`queue.constants.ts`); `main.worker.ts`; `storage-key.ts`; `s3-clients.provider.ts`; `VIDEO_ENV_DEFAULTS` (`config/video.constants.ts`); `ABUSE_LIMITS`; `MEDIA_RULE` / `THUMBNAIL_POLICY` | names, keys, defaults and limits match |
| No contradictions | the new section vs. the existing `nestjs-project/CLAUDE.md`, the root `CLAUDE.md`, `README.md` and the plan | none found; commands are referenced, not duplicated |
| No credentials | the new text names variables and defaults only | no value of `.local/secrets/` or `.env` |

### 9.3 Published-version check

The criterion returns to PASS only once the published `main` contains this section. The check is run after the integration (`dev` → `main`) and is reported with the final SHAs. This file is not edited again for it.

### 9.4 Open point found during the correction — no `title` column (not corrected here)

The brief's persistence paragraph lists, "at least": identification, owner (channel), **title**, status, storage keys of the file and of the thumbnail, duration and metadata, and the unique-URL identifier.

- **What the code has:** the `videos` table has no `title` column. It stores `original_filename`.
- **Storage keys:** they are not stored either. They are derived from the UUID (`videos/<uuid>/original`, `videos/<uuid>/thumbnail.jpg`, TD-10), with `thumbnail_generated_at` recording that the thumbnail exists.
- **Planning sources:** neither `docs/project-plan.md` (Phase 03), nor the plan's Data Model, nor any TD mentions a title. The brief also says the exact model is defined by the plan.
- **Status:** recorded as an **open point awaiting the user's decision**. It is not a PASS or a FAIL of any criterion. Adding a column would be a functional change (entity, migration, DTOs, tests), which is outside this documentation-only correction.
