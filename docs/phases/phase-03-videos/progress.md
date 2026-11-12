# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/17 completed

## Required Technical Verification Gates

_Execution status of the 8 gates listed in context.md → Testing Requirements (that table is the planning snapshot and stays PENDING; editing it would invalidate validation.md). A gate is PASS only with executed evidence and human approval._

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | TypeORM + pg-boss transactional integration (TD-05) | PASS — approved 2026-11-11 | docs/phases/phase-03-videos/spike-pgboss.md; src/queue/pgboss-spike.integration-spec.ts |
| 2 | Pinned MinIO image, SHA-256, Compose, healthcheck, CORS (TD-03, TD-16) | PASS — evidence executed 2026-11-11 (minisign/ARM64 preserved as options, not exercised) | docs/phases/phase-03-videos/gate-02-minio.md |
| 3 | 10 GiB upload end to end (TD-01, TD-08, TD-13) | PENDING | — |
| 4 | Ambiguous completion: identity and integrity proof (TD-02) | PENDING | — |
| 5 | Concurrent completions (TD-02, TD-09) | PENDING | — |
| 6 | Real media fixtures (TD-07, TD-15) | PENDING | — |
| 7 | Presigned URL expiry and renewal (TD-11) | PENDING | — |
| 8 | HTTP Range directly on MinIO (TD-11) | PENDING | — |

### SI-03.1 — Spike: pg-boss × TypeORM (Verification Gate 1)
- **Status:** completed
- **Tests:** 10 passing (src/queue/pgboss-spike.integration-spec.ts, 4 consecutive runs); regression: npm test 206 passing, test:e2e 52 passing, tsc exit 0, eslint baseline unchanged
- **Observations:**
  - Gate 1 PASS approved by the user on 2026-11-11 (evidence: docs/phases/phase-03-videos/spike-pgboss.md); recorded in the gates table above.
  - pg-boss 12 is ESM-only: added src/test/pg-boss-native.cjs + moduleNameMapper (and the cjs extension) in the integration Jest project (package.json). Not in the SI text; required for any Jest test to load pg-boss. SI-03.5 must add the same mapping to the unit project and test/jest-e2e.json.
  - Queue policy finding: singletonKey dedupes only with policy exclusive (not standard); SI-03.5 must create video.process with policy exclusive.
  - retryCount increments on re-claim, not on fail (attempt fence); recovery needs expireInSeconds elapsed + a supervise pass.
  - Out of scope: pg 8.23 deprecation warning from TypeORM clearDatabase (Promise.all on one client) in the existing src/test/prepare-test-database.ts global setup; becomes an error in pg@9.

### SI-03.2 — Infra: configuração e contrato de ambiente (storage, upload, worker, fila)
- **Status:** completed
- **Tests:** 17 passing (env.validation.spec.ts 15, phase-03.config.spec.ts 2); regression on Node 26: npm test 223 passing, test:e2e 52 passing, spike 10/10, tsc 0, eslint baseline
- **Observations:**
  - Runtime pinned to Node.js 26.13.1 LTS (Lithium) by tag + digest in Dockerfile.dev (user condition 1); container rebuilt; argon2 (native) and pg-boss (ESM) load.
  - Spike re-run on Node 26: 10/10 (user condition 2, verified before SI-03.5).
  - Defaults live once in src/config/video.constants.ts (used by Joi and the registerAs factories).
  - .env.example keeps the four credentials empty (AC: no credential value); local .env (git-ignored) received development placeholders so the required keys validate.
  - Existing fixture src/config/env.validation.integration-spec.ts updated with the new required credentials.
  - nestjs-api service in compose.yaml has no environment block (it reads .env); the MinIO and worker services get theirs in SI-03.3 / SI-03.12.

### SI-03.3 — Infra: imagem MinIO fixada e serviço Compose (Verification Gate 2)
- **Status:** completed
- **Tests:** no tests (Infra); 4 ACs verified by executed checks (docs/phases/phase-03-videos/gate-02-minio.md)
- **Observations:**
  - Gate 2 PASS with executed evidence; minisign (no public key in the repo) and ARM64 (amd64 host) kept as documented build args, not exercised.
  - Compose interpolation uses ${VAR:?} so MinIO refuses to start without MINIO_ROOT_USER / MINIO_ROOT_PASSWORD in .env.

### SI-03.4 — Módulo de storage S3 (dois endpoints, presigner, bucket)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Módulo de fila pg-boss (API publica, worker consome)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Entidade Video, migration e identificador público
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Política de acesso e serviço de início de upload
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Endpoints POST /videos e GET /videos/:id
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Endpoints de partes, retomada e cancelamento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Serviço de conclusão do upload (Verification Gates 4 e 5)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Endpoint POST /videos/:id/upload/complete
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Infra: entrypoint do worker e serviço Compose `worker`
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Probe de mídia, regra de formato e thumbnail (Verification Gate 6)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.14 — Worker de processamento do vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.15 — Reaper/reconciliador agendado
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.16 — URLs de reprodução e download (Verification Gates 7 e 8)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.17 — Verificação ponta a ponta de 10 GiB (Verification Gate 3)
- **Status:** pending
- **Tests:** —
- **Observations:** none
