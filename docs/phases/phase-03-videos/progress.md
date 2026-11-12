# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/17 completed

## Required Technical Verification Gates

_Execution status of the 8 gates listed in context.md → Testing Requirements (that table is the planning snapshot and stays PENDING; editing it would invalidate validation.md). A gate is PASS only with executed evidence and human approval._

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | TypeORM + pg-boss transactional integration (TD-05) | PASS — approved 2026-11-11 | docs/phases/phase-03-videos/spike-pgboss.md; src/queue/pgboss-spike.integration-spec.ts |
| 2 | Pinned MinIO image, SHA-256, Compose, healthcheck, CORS (TD-03, TD-16) | PENDING | — |
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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — Infra: imagem MinIO fixada e serviço Compose (Verification Gate 2)
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
