---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-11T22:00:21-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-11T20:36:03-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-11T21:58:35-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-10T20:13:08-03:00"
  docs/project-plan.md: "2026-11-10T20:13:08-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-10T20:13:08-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-10T20:13:08-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-10T20:13:08-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-10T20:13:08-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver, in `nestjs-project/` only, the "Upload e Processamento de Vídeos" phase — serviço de armazenamento de arquivos (vídeos e thumbnails), serviço de processamento em segundo plano (filas), upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance, pré-cadastro automático do vídeo como rascunho ao iniciar o upload, processamento automático do vídeo após upload (extração de duração e metadados), geração automática de thumbnail a partir de um frame do vídeo, URL única por vídeo, reprodução via streaming e download do vídeo pelo usuário — so that upload de até 10GB, processamento automático, streaming and unique URLs work end to end, with every video kept as a private draft (publication and public visibility belong to Phase 04).

---

## Step Implementations

### SI-03.1 — Spike: pg-boss × TypeORM (Verification Gate 1)

**Description:** Prova, antes de qualquer código de fila, que `pg-boss` publica jobs dentro da mesma transação TypeORM que muda o estado do vídeo; é a condição inicial do planejamento da fila (Verification Gate 1).

**Technical actions:**

1. Instalar `pg-boss@^12.x` e atualizar `pg` para `^8.23.1` em `nestjs-project/package.json` (dentro do container), conferindo a API instalada contra `library-refs.md` → `### pg-boss` e registrando a versão efetiva (per `phase-03-videos/TD-05`)
2. Criar `src/queue/typeorm-pgboss-db.adapter.ts` — objeto `{ executeSql(text, values) }` sobre o `QueryRunner`/`EntityManager` da transação corrente, para `send(…, { db })` (per `phase-03-videos/TD-05`; nenhum adaptador TypeORM é documentado)
3. Criar `src/queue/pgboss-spike.integration-spec.ts` contra o banco de teste, com schema `PGBOSS_TEST_SCHEMA`, provando as condições (2)–(8) do TD-05: enqueue na mesma transação, rollback não publica, commit preserva estado + job, inicialização determinística do schema, reset isolado, dedupe por `singletonKey`, retry com backoff, recuperação de job interrompido, nenhuma transação aberta durante o processamento
4. Registrar o resultado em `docs/phases/phase-03-videos/spike-pgboss.md` — versões, mecanismo de schema escolhido (instalação da biblioteca ou DDL de `getConstructionPlans()` via migration), cada condição PASS/FAIL e a evidência; se (2)–(4) falharem, o documento declara o fallback outbox/reconciliação (linha `uploaded` como intenção durável + reconciliador do SI-03.15) e o SI-03.10 usa esse caminho

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `typeorm-pgboss-db.adapter.ts` + pg-boss real | Integration: commit, rollback, dedupe, retry, recuperação, schema isolado | `src/queue/pgboss-spike.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Uma transação que grava uma linha e chama `send(…, { db })` e depois faz **rollback** deixa zero linhas e zero jobs.
- A mesma transação com **commit** deixa a linha e exatamente um job com o `singletonKey` informado.
- Um segundo `send` com o mesmo `singletonKey` não cria outro job.
- O schema `pgboss` é criado de forma determinística, e o reset de teste recusa qualquer schema diferente de `PGBOSS_TEST_SCHEMA`.
- `spike-pgboss.md` existe, marca cada uma das oito condições do TD-05 como PASS ou FAIL e, em caso de FAIL em (2)–(4), declara o fallback adotado.

---

### SI-03.2 — Infra: configuração e contrato de ambiente (storage, upload, worker, fila)

**Description:** Declara, valida e documenta todas as chaves canônicas da fase com seus defaults operacionais, para que os SIs seguintes leiam configuração tipada e nunca constantes.

**Technical actions:**

1. Criar `src/config/storage.config.ts`, `src/config/upload.config.ts`, `src/config/worker.config.ts` e `src/config/queue.config.ts` com `registerAs` (per `phase-01-configuracao-base/TD-03`), registrados no `ConfigModule` existente
2. Estender `src/config/env.validation.ts` (Joi, per `phase-01-configuracao-base/TD-02`) com as chaves do TD-16 e os defaults da tabela abaixo; credenciais (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`) obrigatórias e sem default (per `phase-03-videos/TD-04`); `S3_TEST_BUCKET` deve casar `^[a-z0-9-]+-test$` e `PGBOSS_TEST_SCHEMA` `^[a-z][a-z0-9_]*_test$`, espelhando `DB_TEST_NAME` (per `phase-03-videos/TD-15`)
3. Adicionar regras cruzadas no schema: `PROCESSING_INPUT_PRESIGN_TTL_SECONDS > WORKER_JOB_TIMEOUT_SECONDS` (per `phase-03-videos/TD-08` revisão AMB-3); todo `*_PRESIGN_TTL_SECONDS` ≤ 604800 (SigV4, per `phase-03-videos/TD-04`); `UPLOAD_PART_SIZE_BYTES` ≥ 5242880 e `ceil(MAX_UPLOAD_BYTES / UPLOAD_PART_SIZE_BYTES)` ≤ 10000 (per `phase-03-videos/TD-01`); `MAX_PENDING_UPLOAD_BYTES_PER_OWNER` ≥ `MAX_UPLOAD_BYTES` (per `phase-03-videos/TD-13`)
4. Atualizar `nestjs-project/.env.example` com os nomes e valores vazios/placeholder (nunca credenciais reais nem o `DB_TEST_SERVER_ID`) e o bloco `environment` de `compose.yaml` (per `phase-03-videos/TD-16`)

Defaults operacionais (todos sobrescrevíveis por ambiente; valores fixados pelo plan-build onde o TD delegou):

| Chave | Default | Origem |
|-------|---------|--------|
| `S3_ENDPOINT` | `http://minio:9000` | TD-04 (endpoint interno, nome do serviço Compose) |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` | TD-04 (endpoint público) |
| `S3_REGION` | `us-east-1` | TD-04 |
| `S3_BUCKET` | `streamtube-videos` | plan-build |
| `S3_TEST_BUCKET` | `streamtube-videos-test` | plan-build (TD-15) |
| `S3_FORCE_PATH_STYLE` | `true` | TD-04 |
| `MINIO_API_CORS_ALLOW_ORIGIN` | `http://localhost:3001` | plan-build (origem do futuro frontend; expõe `ETag`) |
| `MAX_UPLOAD_BYTES` | `10737418240` (10 GiB) | TD-13 |
| `UPLOAD_PART_SIZE_BYTES` | `67108864` (64 MiB → 160 partes) | TD-01 |
| `UPLOAD_EXPIRY_HOURS` | `24` | plan-build |
| `UPLOAD_PART_PRESIGN_TTL_SECONDS` | `900` | TD-13 revisão IC-2 |
| `PLAYBACK_PRESIGN_TTL_SECONDS` | `3600` | TD-11 revisão IC-2 |
| `DOWNLOAD_PRESIGN_TTL_SECONDS` | `900` | TD-11 revisão IC-2 |
| `PROCESSING_INPUT_PRESIGN_TTL_SECONDS` | `3600` | plan-build (TD-08 revisão AMB-3; > job timeout) |
| `COMPLETING_STALE_MINUTES` | `15` | plan-build (TD-14 revisão AMB-2) |
| `MAX_ACTIVE_UPLOADS_PER_OWNER` | `3` | plan-build (TD-13 revisão AMB-2) |
| `MAX_PENDING_UPLOAD_BYTES_PER_OWNER` | `21474836480` (20 GiB) | plan-build (TD-13 revisão AMB-2) |
| `WORKER_CONCURRENCY` | `1` | plan-build (TD-16 revisão AMB-2) |
| `WORKER_JOB_TIMEOUT_SECONDS` | `1800` | plan-build (TD-16 revisão AMB-2) |
| `MEDIA_PROBE_TIMEOUT_SECONDS` | `120` | plan-build (TD-16 revisão AMB-2) |
| `MAX_VIDEO_DURATION_SECONDS` | `14400` (4 h) | plan-build (TD-16 revisão AMB-2) — restrição funcional aceita: um arquivo de até 10 GiB com mais de 4 h é rejeitado como `DURATION_LIMIT_EXCEEDED`; o enunciado fixa só o limite de 10 GB, então não há conflito de escopo (ver §Error Catalog) |
| `PGBOSS_SCHEMA` | `pgboss` | plan-build (TD-05) |
| `PGBOSS_TEST_SCHEMA` | `pgboss_test` | plan-build (TD-15) |

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation.ts` (novas chaves, defaults, regras cruzadas, padrões de teste) | Unit | `src/config/env.validation.spec.ts` |
| `storage/upload/worker/queue.config.ts` | Unit: leitura tipada dos valores | `src/config/phase-03.config.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Com apenas as credenciais definidas, a validação aceita o ambiente e cada chave da tabela assume o default listado.
- `PROCESSING_INPUT_PRESIGN_TTL_SECONDS=1800` com `WORKER_JOB_TIMEOUT_SECONDS=1800` é rejeitado na inicialização com mensagem nomeando as duas chaves.
- Um `*_PRESIGN_TTL_SECONDS` acima de `604800`, ou um `UPLOAD_PART_SIZE_BYTES` abaixo de 5 MiB, é rejeitado na inicialização.
- `S3_TEST_BUCKET=streamtube-videos` (sem sufixo `-test`) é rejeitado.
- `.env.example` lista todas as chaves canônicas do TD-16 sem nenhum valor de credencial nem `PRESIGN_TTL_SECONDS`.

---

### SI-03.3 — Infra: imagem MinIO fixada e serviço Compose (Verification Gate 2)

**Description:** Constrói uma imagem reprodutível do MinIO fixado, com verificação de SHA-256 no build, e a sobe no Compose com healthcheck e CORS (Verification Gate 2).

**Technical actions:**

1. Criar `nestjs-project/docker/minio/Dockerfile` — base `debian:12-slim` fixada por tag e digest; `ARG` do release `RELEASE.2025-09-07T16-13-09Z` e do SHA-256 `7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f`; download do asset do GitHub; `sha256sum -c` comparando o hash (não o nome) e falhando o build; verificação minisign opcional com a chave do `Dockerfile.release` da tag; `curl` para o healthcheck; usuário não-root; `VOLUME /data`; `HEALTHCHECK` em `/minio/health/ready` (per `phase-03-videos/TD-03`); asset/checksum ARM64 documentados como `ARG` alternativo quando aplicável
2. Adicionar o serviço `minio` em `nestjs-project/compose.yaml` — build do Dockerfile acima, portas `9000` (API) e `9001` (console), volume nomeado, credenciais de `.env`, `MINIO_API_CORS_ALLOW_ORIGIN`, healthcheck; `nestjs-api` passa a depender de `minio` com `condition: service_healthy` (per `phase-03-videos/TD-16`)
3. Atualizar `nestjs-project/CLAUDE.md` (Environment Startup Verification) e `README.md` com a checagem de prontidão do MinIO (`docker compose exec minio curl -fsS http://localhost:9000/minio/health/ready`)

**Tests:** _(empty — Infra; smoke-gated by build and healthcheck ACs; storage behavior tested in SI-03.4)_

**Dependencies:** SI-03.2 — as chaves `MINIO_*` e `S3_*` vêm do contrato de ambiente

**Acceptance criteria:**

- `docker compose build minio` com um SHA-256 alterado no `ARG` falha no passo de verificação.
- `docker compose up -d minio` leva o serviço a `healthy`, e `curl -fsS http://localhost:9000/minio/health/ready` no host retorna `200`.
- O processo do MinIO dentro do container roda com usuário diferente de `root`.
- Uma requisição de preflight `OPTIONS` à API do MinIO com `Origin` igual a `MINIO_API_CORS_ALLOW_ORIGIN` é aceita, e a resposta a um `PUT` expõe o header `ETag`.

---

### SI-03.4 — Módulo de storage S3 (dois endpoints, presigner, bucket)

**Description:** Entrega o `StorageModule` compartilhado por API e worker: um cliente para operações internas e outro só para assinar URLs públicas, mais a criação do bucket e o guard do bucket de teste.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3@^3.x` e `@aws-sdk/s3-request-presigner@^3.x`, conferindo a API instalada contra `library-refs.md` → `### @aws-sdk/client-s3` e `### @aws-sdk/s3-request-presigner` (per `phase-03-videos/TD-04`)
2. Criar `src/storage/storage.module.ts` e `src/storage/s3-clients.provider.ts` — `internalClient` com `S3_ENDPOINT` e `publicSigner` com `S3_PUBLIC_ENDPOINT`, ambos `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'` (sem parâmetros `x-amz-checksum-*` nas URLs assinadas) e credenciais só de `storageConfig` (per `phase-03-videos/TD-04`). **Política de timeout** (constantes em `src/storage/storage-timeouts.ts`): `connectionTimeout` 3 s e `requestTimeout` 15 s em todas as operações de controle, mais um `AbortSignal` com o mesmo teto; `maxAttempts: 1` (sem retry interno do SDK) em `CreateMultipartUpload` e `CompleteMultipartUpload`, para que cada tentativa seja classificada pela aplicação; nenhuma chamada espera sem limite
3. Criar `src/storage/storage.service.ts` — wrappers tipados de `CreateMultipartUpload` (com metadado `upload-binding`), `ListParts` paginado por `PartNumberMarker`/`NextPartNumberMarker`, `ListMultipartUploads` por prefixo da chave do vídeo (para abortar multiparts órfãos), `CompleteMultipartUpload` (uma resposta `200` com `<Error>` no corpo é tratada como erro, nunca como sucesso), `AbortMultipartUpload`, `HeadObject` (devolve `ContentLength`, `ETag` e metadados), `PutObject` e `DeleteObject`; `presignUploadPart`, `presignGet` (público, com `ResponseContentDisposition` opcional) e `presignInternalGet` (interno, para o worker); erros classificados por `error.name`/código S3 (não só pelo status HTTP) em `definitive`, `transient` e `ambiguous` — inclusive o erro que o SDK extrai de um `200` com `<Error>` no corpo —, `NoSuchUpload` mapeado para `UploadNotFoundError`; e `src/storage/storage-key.ts` com `originalKey(id)` = `videos/<id>/original` e `thumbnailKey(id)` = `videos/<id>/thumbnail.jpg`, apenas a partir do UUID interno (per `phase-03-videos/TD-02`, `phase-03-videos/TD-08`, `phase-03-videos/TD-10`, `phase-03-videos/TD-11`)
4. Criar `src/storage/multipart-cleanup.ts` → `confirmUploadsGone(key, knownUploadIds, bindingToken)`, devolvendo `aborted | completed | indeterminate`: (a) lista **todas** as sessões da chave exclusiva por `ListMultipartUploads` paginado (`KeyMarker`/`UploadIdMarker`, só a chave exata) e une com os `knownUploadIds`; (b) para cada sessão, `AbortMultipartUpload` repetido com backoff até `ListParts` responder `NoSuchUpload` (partes em trânsito podem recriar partes depois do primeiro abort), com teto de tentativas; (c) `HeadObject` da chave: `404` → sem objeto; presente com `upload-binding = bindingToken` → `completed` (o upload concluiu e segue para a prova do SI-03.10); presente com outro binding ou metadado ilegível → `indeterminate`. Resultado `aborted` só quando todas as sessões responderam `NoSuchUpload` **e** o `HeadObject` respondeu `404`; qualquer erro, teto atingido ou listagem incompleta → `indeterminate`. A lista vazia sozinha nunca é prova (per `phase-03-videos/TD-14`, `phase-03-videos/TD-02`)
5. Criar `src/storage/bucket-bootstrap.service.ts` (cria `S3_BUCKET` na inicialização se ausente, sem `mc`, per `phase-03-videos/TD-03`) e `src/test/test-storage.ts` (usa `S3_TEST_BUCKET` e recusa esvaziar qualquer bucket que não seja o de teste, per `phase-03-videos/TD-15`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` contra MinIO real | Integration (side-effect dep, real service): multipart completo, `ListParts` paginado, `NoSuchUpload`, `HeadObject`, presign interno vs público | `src/storage/storage.service.integration-spec.ts` |
| `multipart-cleanup.ts` + classificação de erros | Unit: `aborted`/`completed`/`indeterminate`, paginação, teto de tentativas, `200` com `<Error>` | `src/storage/multipart-cleanup.spec.ts` |
| `test-storage.ts` (guard) | Unit: recusa bucket sem sufixo `-test` | `src/test/test-storage.spec.ts` |
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.2 (configuração `storageConfig`), SI-03.3 (MinIO no Compose)

**Acceptance criteria:**

- Após a inicialização com o bucket ausente, `S3_BUCKET` existe no MinIO.
- Uma URL de `presignUploadPart` contém o host de `S3_PUBLIC_ENDPOINT`, não contém `x-amz-checksum`, e um `PUT` de 5 MiB nela retorna `200` com `ETag`.
- Uma URL de `presignInternalGet` contém o host de `S3_ENDPOINT` e é aceita a partir do container da API.
- `ListParts` de um upload com mais partes que o tamanho de página retorna todas as partes, na ordem.
- No MinIO fixado, `confirmUploadsGone` devolve `aborted` para uma chave com duas sessões abertas (uma desconhecida), `completed` para uma chave com objeto concluído com o binding esperado e `indeterminate` com o storage parado.
- Esvaziar um bucket chamado `streamtube-videos` pelo helper de teste é recusado antes de qualquer chamada ao storage.
- Com o MinIO pausado, um `CreateMultipartUpload` termina em no máximo 15 s com erro classificado `ambiguous`, e o SDK não o reenvia.

---

### SI-03.5 — Módulo de fila pg-boss (API publica, worker consome)

**Description:** Transforma o resultado do spike em um `QueueModule` de produção: ciclo de vida do `pg-boss`, criação determinística das filas e do schema, publicação transacional e o guard do schema de teste.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` e `src/queue/pgboss.provider.ts` — instância `PgBoss` com a conexão de `databaseConfig` e `schema` de `queueConfig`, `start()` com `attempts` e `stop()` gracioso no shutdown do Nest; o mecanismo de schema é o registrado em `spike-pgboss.md` (per `phase-03-videos/TD-05`; conexão sem duplicar parâmetros, per Inherited Conventions)
2. Criar `src/queue/queue-names.ts` (`video.process`, `video.reconcile`) e `src/queue/job-publisher.service.ts` — `publishVideoProcess(videoId, manager)` chama `send('video.process', { videoId }, { db: adapter(manager), singletonKey: videoId, retryLimit, retryBackoff: true, expireInSeconds })`, com `expireInSeconds` derivado de `WORKER_JOB_TIMEOUT_SECONDS` (per `phase-03-videos/TD-05`; ver §Events/Messages)
3. Mover o adaptador do spike para `src/queue/typeorm-pgboss-db.adapter.ts` definitivo (ou, se o spike falhou em (2)–(4), expor `publishVideoProcess` sem `db` e documentar que o reconciliador do SI-03.15 é a garantia de entrega)
4. Criar `src/test/test-queue.ts` — inicializa e reseta apenas `PGBOSS_TEST_SCHEMA`, recusando qualquer outro schema (per `phase-03-videos/TD-15`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `JobPublisherService` + pg-boss real | Integration: publicação transacional, `singletonKey`, opções de retry | `src/queue/job-publisher.service.integration-spec.ts` |
| `test-queue.ts` (guard) | Unit | `src/test/test-queue.spec.ts` |
| `QueueModule` | Unit: compilation test | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.1 (resultado do spike decide o caminho), SI-03.2 (`queueConfig`, `workerConfig`)

**Acceptance criteria:**

- Após a inicialização da API, as filas `video.process` e `video.reconcile` existem no schema `PGBOSS_SCHEMA`.
- `publishVideoProcess` chamado duas vezes para o mesmo vídeo resulta em um único job `video.process` com `data.videoId` igual ao UUID do vídeo.
- `publishVideoProcess` dentro de uma transação que faz rollback não deixa job (caminho transacional) — ou, no caminho fallback documentado, não é chamado antes do commit.
- O reset do helper de teste recusa o schema `pgboss` antes de executar qualquer DDL.

---

### SI-03.6 — Entidade Video, migration e identificador público

**Description:** Cria a tabela `videos` com os campos, enums e índices do §Data Model e o gerador de `public_id` base62 com retry limitado em colisão.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — campos, tipos e restrições exatamente como §Data Model → `Video`, relação `ManyToOne` com `Channel` e `OneToMany` inversa em `src/channels/entities/channel.entity.ts` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-10`)
2. Gerar a migration `src/database/migrations/<timestamp>-CreateVideos.ts` com os enums `video_publication` e `video_processing_status`, os checks (`declared_size_bytes > 0`, `expected_part_count` entre 1 e 10000) e os quatro índices do §Data Model; adicioná-la a `TEST_MIGRATIONS` em `src/test/test-migrations.ts`
3. Criar `src/videos/public-id.generator.ts` — 11 caracteres base62 a partir de `crypto.randomBytes` com rejection sampling (sem viés de módulo), e `insertWithUniquePublicId` que tenta de novo até 3 vezes somente quando o `public_id` colide, via `INSERT … ON CONFLICT (public_id) DO NOTHING RETURNING` — a transação nunca chega a ser abortada, então o retry não cai na armadilha do CHANNEL-NICKNAME-RACE; esgotadas as tentativas, erro interno explícito (per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, enums, índices únicos | `src/videos/entities/video.entity.integration-spec.ts` |
| `public-id.generator.ts` | Unit: alfabeto, tamanho, distribuição, retry | `src/videos/public-id.generator.spec.ts` |
| `insertWithUniquePublicId` | Integration: colisão forçada resolvida sem abortar a transação | `src/videos/public-id.generator.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Inserir um vídeo sem `publication` grava `draft`.
- Inserir dois vídeos com o mesmo `public_id` falha com violação de unicidade; com o mesmo (`channel_id`, `idempotency_key`) também.
- Inserir `declared_size_bytes = 0` ou `expected_part_count = 10001` falha por check constraint.
- Um insert cujo primeiro `public_id` colide grava o vídeo com um segundo `public_id` na mesma transação, que continua utilizável.
- `public_id` gerado tem 11 caracteres, todos em `[0-9A-Za-z]`.
- Com o gerador forçado a colidir em todas as tentativas, o insert falha após 3 tentativas com erro explícito, sem gravar linha.

---

### SI-03.7 — Política de acesso e serviço de início de upload

**Description:** Implementa a função única de ownership e o caso de uso "iniciar upload": rascunho privado, idempotência, cotas por dono e criação do multipart, sem ainda expor HTTP.

**Technical actions:**

1. Criar `src/videos/video-access.policy.ts` — `findOwnedVideoOrThrow(publicId, userId)` resolve o canal do usuário e lança `VideoNotFoundException` para id malformado, inexistente ou de outro canal (per `phase-03-videos/TD-12`); criar as exceções do §Error Catalog em `src/videos/video.exceptions.ts` como subclasses de `DomainException`
2. Criar `src/videos/video-upload.service.ts` → `start(userId, idempotencyKey, dto)` — exige canal (`CHANNEL_REQUIRED`), aplica `MAX_UPLOAD_BYTES` (`UPLOAD_SIZE_EXCEEDED`), sanitiza `filename` (remove caminhos e caracteres de controle) e calcula `part_size_bytes`/`expected_part_count` de `UPLOAD_PART_SIZE_BYTES` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-13`)
3. **Reserva atômica — uma única transação PostgreSQL**, na ordem: (i) `BEGIN`; (ii) `SELECT … FROM users WHERE id = $1 FOR UPDATE` na linha do **proprietário**, que serializa os `start` de todos os canais desse usuário (hoje `channels.user_id` é `UNIQUE`; as somas agregam todos os canais do usuário, então a regra continua correta se houver mais de um canal); (iii) verificação de idempotência por (`channel_id`, `idempotency_key`) — mesmo `filename` e `size_bytes` devolve a reserva existente, valores diferentes dão `IDEMPOTENCY_KEY_CONFLICT` — e cálculo das cotas do proprietário: ritmo (`UPLOAD_START_RATE_EXCEEDED`: 20 vídeos por hora, contados em `created_at`), `ACTIVE_UPLOAD_LIMIT_EXCEEDED` contra `MAX_ACTIVE_UPLOADS_PER_OWNER` e `PENDING_UPLOAD_QUOTA_EXCEEDED` contra `MAX_PENDING_UPLOAD_BYTES_PER_OWNER`; (iv) quando admitida, inserção da reserva `uploading` com `upload_id = NULL`, `upload_binding_token` aleatório e `upload_expires_at = now + UPLOAD_EXPIRY_HOURS`; (v) `COMMIT`. Verificação e inserção nunca ficam em transações separadas; qualquer falha antes do `COMMIT` faz rollback e o `start` é recusado (fail-closed). Nenhuma chamada ao MinIO acontece dentro dessa transação — a capacidade fica reservada a partir do `COMMIT` (per `phase-03-videos/TD-13` revisão AMB-2, `phase-03-videos/TD-02`)
4. **Criação do multipart (fase 2, somente depois do `COMMIT` da reserva, sem transação aberta durante I/O):** num `QueryRunner` dedicado, `pg_try_advisory_lock` de sessão pelo id do vídeo — a chamada é **não bloqueante**: devolve `true` ou `false` imediatamente, e `lock_timeout` não se aplica a ela (nenhuma espera é criada); `false` → `UPLOAD_START_IN_PROGRESS` com `Retry-After`. O lock impede retries concorrentes de criar duas sessões para a mesma reserva. O `pg_advisory_unlock` roda em `finally` **na mesma conexão dedicada**; se ele falhar ou não devolver `true`, a conexão é descartada (destruída, não devolvida ao pool), e o PostgreSQL libera o lock de sessão ao fechá-la. Cada escrita é um statement autocommit curto, nunca uma transação que atravessa a chamada ao MinIO; com `upload_id` já gravado → devolve a reserva; com `upload_id IS NULL`, gravar `multipart_create_attempted_at = now()` (evidência para o reconciliador) e investigar a chave exclusiva `videos/<id>/original` por `confirmUploadsGone` (SI-03.4) com o `upload_binding_token` gerado na reserva, **antes** de qualquer `CreateMultipartUpload`: `aborted` (nenhuma sessão, nenhum objeto) → `CreateMultipartUpload` com o metadado `upload-binding` e `UPDATE … SET upload_id = $1 WHERE id = $2 AND upload_id IS NULL`; `indeterminate` → mantém a reserva e responde `STORAGE_UNAVAILABLE` com `Retry-After`, deixando o reconciliador (SI-03.15) continuar. O `CreateMultipartUpload` usa a política de timeout do SI-03.4 (sem retry interno do SDK). Erro **definitivo** → `DELETE … WHERE id = $1 AND upload_id IS NULL` apaga a reserva (nenhuma sessão foi criada); **ambíguo** (timeout, reset, 5xx, resposta perdida — a sessão pode existir sem `upload_id` gravado) → a reserva já commitada na fase 1 e o `multipart_create_attempted_at` permanecem, e o reconciliador retoma a investigação. Nenhum caminho de erro desfaz a reserva da fase 1 por rollback (per `phase-03-videos/TD-02`, `phase-03-videos/TD-05` condição (8), `phase-03-videos/TD-14`)
5. A capacidade só é liberada pelas transições para `uploaded`, `failed`, `expired` ou `cancelled`, e `expired`/`cancelled` só acontecem depois do abort confirmado pelo storage; nenhum caminho de erro libera a cota sem essa confirmação (per §Data Model → Quota accounting)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadService.start` | Unit: ramos de validação, cotas, idempotência, falha de storage (mock repo/storage) | `src/videos/video-upload.service.spec.ts` |
| `VideoUploadService.start` | Integration: cotas sob concorrência do mesmo proprietário (lock em `users`), unique (`channel_id`, `idempotency_key`), perda de resposta na criação e retries concorrentes via proxy de injeção, MinIO real | `src/videos/video-upload.service.integration-spec.ts` |

_Nota: um teste com dois canais distintos do mesmo proprietário não é construível hoje — `channels.user_id` é `UNIQUE` (um canal por usuário). O teste de concorrência acima usa dois `start` do mesmo proprietário e afirma que o lock é tomado na linha de `users`, não na do canal._
| `video-access.policy.ts` | Unit: dono, outro canal, id malformado | `src/videos/video-access.policy.spec.ts` |

**Dependencies:** SI-03.4 (storage), SI-03.6 (entidade `Video`)

**Acceptance criteria:**

- `start` com tamanho válido grava um vídeo `uploading`/`draft` com `upload_id`, `expected_part_count = ceil(size / part_size)` e `upload_expires_at` no futuro.
- `start` repetido com a mesma chave e o mesmo payload devolve o mesmo `public_id` e o mesmo `upload_id`, e o storage tem um único multipart aberto para o vídeo.
- Com `MAX_ACTIVE_UPLOADS_PER_OWNER=1` e um upload aberto, um segundo `start` falha com `ACTIVE_UPLOAD_LIMIT_EXCEEDED` e nenhum multipart novo é criado.
- Concorrência por proprietário, com a capacidade configurada para admitir uma única solicitação: (i) `MAX_ACTIVE_UPLOADS_PER_OWNER=1` e `MAX_PENDING_UPLOAD_BYTES_PER_OWNER` amplo — dois `start` concorrentes do mesmo usuário, com chaves diferentes, resultam em exatamente uma reserva e um `ACTIVE_UPLOAD_LIMIT_EXCEEDED`; (ii) `MAX_ACTIVE_UPLOADS_PER_OWNER=3` e `MAX_PENDING_UPLOAD_BYTES_PER_OWNER` igual ao tamanho de uma solicitação — dois `start` concorrentes desse tamanho resultam em exatamente uma reserva e um `PENDING_UPLOAD_QUOTA_EXCEEDED`. Com os defaults (3 ativos, 20 GiB), duas solicitações de 10 GiB são ambas admitidas, e o teste afirma isso também.
- Com `MAX_PENDING_UPLOAD_BYTES_PER_OWNER` pequeno, um `start` que ultrapassa a soma falha com `PENDING_UPLOAD_QUOTA_EXCEEDED`; após o primeiro upload sair de `uploading`/`completing`, o mesmo `start` passa.
- `filename` `../../etc/passwd\u0007.mp4` é gravado como `passwd.mp4`.
- Com `CreateMultipartUpload` rejeitado definitivamente (injeção de falha), a resposta é `503` `STORAGE_UNAVAILABLE`, não sobra linha do vídeo e um novo `start` do mesmo canal não é bloqueado pela cota.
- Com `CreateMultipartUpload` concluído no storage mas a resposta perdida (injeção), a reserva fica com `upload_id = NULL` e continua contando na cota; o `start` repetido com a mesma chave aborta a sessão órfã, cria uma nova e termina com um único `upload_id` e um único multipart aberto na chave do vídeo.
- Três `start` repetidos simultâneos com a mesma chave, após uma perda de resposta na criação, resultam em um único multipart aberto; as requisições que não obtêm o lock recebem `409` com `error: "UPLOAD_START_IN_PROGRESS"` imediatamente, sem esperar; com o `pg_advisory_unlock` forçado a falhar, a conexão dedicada é descartada e um `start` seguinte obtém o lock.
- Com o storage inacessível durante a investigação de uma reserva sem `upload_id`, a reserva é mantida, a resposta é `503` `STORAGE_UNAVAILABLE` e nenhum multipart novo é criado.- O 21º `start` de um canal dentro de uma hora retorna `429` com `error: "UPLOAD_START_RATE_EXCEEDED"`, sem criar reserva.

---

### SI-03.8 — Endpoints POST /videos e GET /videos/:id

**Route:** POST /videos, GET /videos/:id
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated (start); Owner (status) — ver §Authorization Matrix

**Description:** Expõe o início do upload e o status do rascunho sobre o serviço do SI-03.7, criando o `VideosModule` e o controller com opt-out explícito de throttling.

**Technical actions:**

1. Criar `src/videos/videos.module.ts` (importa `StorageModule`, `QueueModule`, `TypeOrmModule.forFeature([Video, Channel])`) e registrá-lo em `AppModule`
2. Criar `src/videos/videos.controller.ts` com `@SkipThrottle()` no controller (per `phase-03-videos/TD-13` revisão ICC-1) e `@CurrentUser()` para o usuário autenticado; `POST /videos` lê `Idempotency-Key` do header e responde `201` na criação e `200` na repetição, com os campos de §API Contracts → `POST /videos`
3. Criar `src/videos/dto/start-upload.dto.ts` e `src/videos/dto/video-response.dto.ts` com `class-validator` (per `phase-02-auth/TD-06`) e `src/videos/video-response.mapper.ts`; `GET /videos/:id` passa por `findOwnedVideoOrThrow` e devolve os campos de §API Contracts → `GET /videos/:id` (`has_thumbnail` a partir de `thumbnail_generated_at`)
4. Documentar as duas rotas com `@ApiOperation`, `@ApiResponse` por status e o envelope de erro (per `openapi-docs-nestjs/TD-01` revisão), e regenerar `openapi.json` (per `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `video-response.mapper.ts` | Unit: mapeamento de campos, `has_thumbnail`, nenhum `upload_id` em `GET` | `src/videos/video-response.mapper.spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.5 (`QueueModule` importado pelo módulo), SI-03.7 (serviço de início e política)

**Acceptance criteria:**

- `POST /videos` com `Idempotency-Key` e `{ filename, size_bytes }` válidos retorna `201` com `id`, `upload_id`, `part_size_bytes`, `expected_part_count`, `upload_expires_at`, `processing_status: "uploading"` e `publication: "draft"`.
- A mesma requisição repetida retorna `200` com o mesmo `id` e o mesmo `upload_id`.
- `POST /videos` sem `Idempotency-Key` retorna `400` com `error: "VALIDATION_ERROR"`; com `size_bytes` acima de `MAX_UPLOAD_BYTES` retorna `400` com `error: "UPLOAD_SIZE_EXCEEDED"`.
- `GET /videos/:id` pelo dono retorna `200` com `publication: "draft"`; por outro usuário autenticado, ou com id malformado, retorna `404` com `error: "VIDEO_NOT_FOUND"`.
- Mais de 10 chamadas por minuto a `POST /videos` do mesmo cliente não recebem `429` do throttler (o limite de autenticação não se aplica às rotas de vídeo).
- Qualquer rota sem token retorna `401`.

_Cobertura exigida dos testes de endpoint (para `/plan-test-specs`): falhas e recuperação de `CreateMultipartUpload` em `POST /videos` — rejeição definitiva (reserva apagada), resultado ambíguo (reserva mantida, `upload_id = NULL`), repetição com a mesma `Idempotency-Key`, `UPLOAD_START_IN_PROGRESS` em repetições concorrentes —; nenhuma liberação de reserva com resultado `indeterminate`._

---

### SI-03.9 — Endpoints de partes, retomada e cancelamento

**Route:** POST /videos/:id/upload/part-urls, GET /videos/:id/upload, DELETE /videos/:id/upload
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner — ver §Authorization Matrix

**Description:** Entrega as três operações do upload em andamento — URLs de parte reemitíveis, retomada a partir do que o storage já tem e cancelamento — com os estados permitidos de cada uma.

**Technical actions:**

1. Adicionar a `VideoUploadService` `issuePartUrls(video, partNumbers)` — exige `uploading`, `upload_id` presente e prazo válido (`INVALID_VIDEO_STATE`, `UPLOAD_EXPIRED`); reserva a emissão com `UPDATE videos SET part_urls_issued = part_urls_issued + $n WHERE id = $id AND part_urls_issued + $n <= 10 * expected_part_count RETURNING` (zero linhas → `PART_URL_LIMIT_EXCEEDED`) e só então assina cada parte com `UPLOAD_PART_PRESIGN_TTL_SECONDS` no endpoint público (per `phase-03-videos/TD-01`, `phase-03-videos/TD-13` revisão IC-2)
2. Criar `src/videos/control-rate.ts` → `reserveControlCall(videoId)` — janela de uma hora com reserva atômica em `control_calls_issued`/`control_window_started_at` (teto 120, `UPLOAD_CONTROL_RATE_EXCEEDED`), verificada antes de qualquer chamada ao storage e compartilhada com o `complete` (SI-03.11); adicionar `getUploadStatus(video)` — reserva a chamada, `ListParts` paginado e cálculo de `missing_part_numbers` em `1..expected_part_count`; permitido em `uploading`/`completing` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-13`)
3. Adicionar `abort(video)` — só em `uploading`; `confirmUploadsGone(originalKey, [upload_id], upload_binding_token)` (SI-03.4): `aborted` → compare-and-set `uploading → cancelled` (libera a cota); `completed` → nenhuma transição, `INVALID_VIDEO_STATE` (o upload concluiu e segue pela prova do SI-03.10); `indeterminate` → linha inalterada, cota mantida, `STORAGE_UNAVAILABLE`; já `cancelled` responde sem efeito (per `phase-03-videos/TD-09`, `phase-03-videos/TD-14`)
4. Adicionar as três rotas ao `VideosController` com os DTOs `src/videos/dto/part-urls.dto.ts` e `src/videos/dto/upload-status-response.dto.ts`, `Cache-Control: no-store` na resposta de URLs e documentação OpenAPI; regenerar `openapi.json` (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `issuePartUrls` / `getUploadStatus` / `abort` | Unit: estados permitidos, prazo, faltantes | `src/videos/video-upload-parts.service.spec.ts` |
| `getUploadStatus` / `abort` contra MinIO real | Integration: retomada após upload parcial, abort invalida URLs pendentes | `src/videos/video-upload-parts.service.integration-spec.ts` |

**Dependencies:** SI-03.8 (controller e módulo)

**Acceptance criteria:**

- `POST /videos/:id/upload/part-urls` com `{ part_numbers: [1, 2] }` retorna `200` com duas entradas `{ part_number, url, expires_at }`, `expires_at` cerca de `UPLOAD_PART_PRESIGN_TTL_SECONDS` à frente, e header `Cache-Control: no-store`.
- `part_numbers` com valor fora de `1..expected_part_count` ou duplicado retorna `400` com `error: "VALIDATION_ERROR"`.
- Depois de enviar as partes 1 e 3 de 3, `GET /videos/:id/upload` retorna `parts` com os números 1 e 3 (tamanho e `etag`) e `missing_part_numbers: [2]`.
- Pedir URLs após `upload_expires_at` retorna `409` com `error: "UPLOAD_EXPIRED"`.
- Para um upload de 2 partes, pedidos que somam 20 URLs são aceitos e o pedido seguinte retorna `429` com `error: "PART_URL_LIMIT_EXCEEDED"`; pedidos simultâneos nunca ultrapassam o teto.
- `DELETE /videos/:id/upload` retorna `204`, o vídeo passa a `cancelled`, e um `PUT` numa URL de parte emitida antes falha no storage.
- `DELETE /videos/:id/upload` com o vídeo em `completing` retorna `409` com `error: "INVALID_VIDEO_STATE"`; com o storage inacessível, retorna `503` `STORAGE_UNAVAILABLE` e o vídeo continua `uploading` e contando na cota.
- A 121ª chamada a `GET /videos/:id/upload` do mesmo vídeo dentro de uma hora retorna `429` com `error: "UPLOAD_CONTROL_RATE_EXCEEDED"`, sem chamar `ListParts`.

_Cobertura exigida dos testes de endpoint (para `/plan-test-specs`): o limite compartilhado de 120 chamadas/hora com `POST /videos/:id/upload/complete`; falha e recuperação de `AbortMultipartUpload` em `DELETE /videos/:id/upload` (erro, storage parado, abort repetido); nenhuma liberação de reserva nem transição para `cancelled` com resultado `indeterminate`._

---

### SI-03.10 — Serviço de conclusão do upload (Verification Gates 4 e 5)

**Description:** Implementa o protocolo de conclusão do TD-02 com claim compare-and-set, prova de identidade do objeto e publicação do job, cobrindo a conclusão ambígua (Gate 4) e a concorrência de conclusões (Gate 5).

**Technical actions:**

1. Criar `src/videos/video-completion.service.ts` → `complete(video, manifest)` passos (1)–(3) do TD-02: vídeo em `uploading` e no prazo, manifesto estritamente crescente `1..N` com `N = expected_part_count`, verificação somente leitura por `ListParts` paginado (número, tamanho e `ETag` de cada parte; toda parte exceto a última com `part_size_bytes`, a última não maior; soma = `declared_size_bytes`; sem partes extras ou faltantes) → senão `UPLOAD_PARTS_MISMATCH` sem chamar `Complete`; falha de transporte aqui → `STORAGE_UNAVAILABLE` sem claim (per `phase-03-videos/TD-02`)
2. Claim `UPDATE videos SET processing_status = 'completing', completing_since = now() WHERE id = $1 AND processing_status = 'uploading'`; zero linhas → ler o estado atual: depois de `uploading` → `200`; `completing` → `202` com `Retry-After`; terminal → `INVALID_VIDEO_STATE` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-09`)
3. Criar `src/videos/completion-proof.ts` — a prova de conclusão combina, e exige **todos** os elementos obrigatórios: (a) bucket `S3_BUCKET` e chave `videos/<id>/original` exclusivos do vídeo, derivados só do UUID interno, e nunca expostos a outro upload; (b) `upload_id` gravado pelo backend no `start`, único usado em `ListParts`/`Complete`; (c) manifesto verificado pelo servidor contra o `ListParts` paginado no passo (3); (d) `HeadObject.ContentLength = declared_size_bytes`; (e) metadado `upload-binding` do `HeadObject` igual a `upload_binding_token`. O `ETag` final é um token de versão opaco e **nunca** um checksum do arquivo (per `phase-03-videos/TD-02`): ele só entra na prova como verificação adicional se o Gate 4 comprovar e registrar que o MinIO fixado fornece um `ETag` final determinístico para o manifesto; sem essa evidência registrada, não é usado (per `phase-03-videos/TD-02` revisão IC-1)
4. Passos (5)–(8): `CompleteMultipartUpload` com o manifesto ordenado; sucesso + prova completa → numa transação, `completing → uploaded` e `publishVideoProcess` (per `phase-03-videos/TD-05`); prova **contradita** (tamanho ou `upload-binding` divergente) → `failed`/`UPLOAD_INVALID` e `DeleteObject`; prova que **não pode ser estabelecida** (objeto ausente, `HeadObject` indisponível, metadado ilegível) → nenhuma transição, linha fica `completing` (falha segura). O desfecho de `CompleteMultipartUpload` é classificado pelo código S3 do erro (o mesmo para um erro HTTP e para o erro que o SDK extrai de um `200` com `<Error>` no corpo), nunca só pelo status: **definitivo** (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `MalformedXML`, `InvalidArgument`, outro 4xx com código) → o objeto não foi criado → `completing → uploading` + `UPLOAD_PARTS_MISMATCH`; `NoSuchUpload` → `resolveCompleting`; **transitório** (`InternalError`, `ServiceUnavailable`, `SlowDown`, 503 — o S3 declara o `Complete` seguro de repetir) → linha fica `completing`, o `Complete` pode ser reemitido com o mesmo manifesto, resposta `202`; **ambíguo** (timeout, reset de conexão, resposta perdida ou ilegível, 5xx sem código) → linha fica `completing`, nenhum reenvio antes de coletar evidência por `HeadObject`/`ListParts`, resposta `202` com `Retry-After`
5. Criar `src/videos/upload-recovery.ts` — `resolveCompleting(video)` usado pelo `complete` repetido e pelo reconciliador, sempre pela mesma `completion-proof.ts`: prova completa → `uploaded` + job; prova contradita → `failed`/`UPLOAD_INVALID`; `NoSuchUpload`, sem objeto válido e prazo vigente → `failed`/`UPLOAD_LOST`; prazo vencido e sem objeto válido → `expired`; evidência ambígua → nenhuma transição (per `phase-03-videos/TD-02` revisão IC-1, `phase-03-videos/TD-09` revisão IC-1)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoCompletionService` | Unit: cada ramo do protocolo e da matriz de falhas (mock storage/repo) | `src/videos/video-completion.service.spec.ts` |
| `completion-proof.ts` | Unit: cada elemento obrigatório da prova; contradita vs não estabelecida; `ETag` usado só com a evidência registrada | `src/videos/completion-proof.spec.ts` |
| `upload-recovery.ts` | Unit: matriz de recuperação (prova completa, perda, expiração, ambíguo) | `src/videos/upload-recovery.spec.ts` |
| Conclusão contra o MinIO fixado + PostgreSQL | Integration: Gate 4 (manifesto reordenado, parte substituída, resposta perdida, `200` com erro embutido via proxy de injeção, semântica do `ETag` final registrada) e Gate 5 (conclusões simultâneas) | `src/videos/video-completion.service.integration-spec.ts` |

**Dependencies:** SI-03.5 (publicação transacional), SI-03.9 (upload em andamento e `ListParts`)

**Acceptance criteria:**

- Um manifesto que confere com o storage leva o vídeo a `uploaded` e cria exatamente um job `video.process` com `data.videoId` igual ao UUID do vídeo.
- Um manifesto com o `ETag` de uma parte trocado resulta em `UPLOAD_PARTS_MISMATCH`, o vídeo continua `uploading` e nenhum `CompleteMultipartUpload` é emitido.
- Cinco conclusões simultâneas do mesmo vídeo resultam em uma única transição para `uploaded`, um único job e as demais respostas `200` ou `202` — nenhuma `500` e nenhum efeito duplicado (Gate 5).
- Com a resposta de `CompleteMultipartUpload` descartada após o storage concluir, o vídeo fica `completing`; o `complete` repetido estabelece a prova (chave exclusiva, `upload_id`, manifesto do `ListParts`, tamanho e `upload-binding`) e só então passa a `uploaded` (Gate 4).
- Um manifesto com duas partes trocadas de posição é recusado antes do claim; uma parte reenviada com outro conteúdo depois de o cliente registrar o `ETag` resulta em `UPLOAD_PARTS_MISMATCH` (Gate 4).
- Uma resposta `200` de `CompleteMultipartUpload` com `<Error><Code>InternalError</Code>` no corpo deixa o vídeo `completing` com resposta `202`; com `<Code>InvalidPart</Code>` no corpo, volta a `uploading` com `409` `UPLOAD_PARTS_MISMATCH` (Gate 4).
- Um objeto em `videos/<id>/original` com o tamanho declarado mas `upload-binding` diferente do `upload_binding_token` termina em `failed`/`UPLOAD_INVALID`; com `HeadObject` indisponível, o vídeo continua `completing`.
- Um timeout simulado de `CompleteMultipartUpload` nunca devolve o vídeo a `uploading` nem o marca `failed`; com o storage inacessível antes do claim, a resposta é `STORAGE_UNAVAILABLE` e o vídeo continua `uploading`.
- O relatório do Gate 4 registra se o `ETag` final do MinIO fixado é determinístico para o manifesto; o gate só pode ser marcado PASS com todos os cenários acima verificados no MinIO fixado.

---

### SI-03.11 — Endpoint POST /videos/:id/upload/complete

**Route:** POST /videos/:id/upload/complete
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner — ver §Authorization Matrix

**Description:** Expõe o serviço de conclusão do SI-03.10 com os três desfechos HTTP do protocolo (200, 202 com `Retry-After`, 409/503).

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` — `parts: { part_number, etag }[]` com validação de ordem estritamente crescente a partir de 1 e formato de `etag` (per §API Contracts → Validation Rules, `phase-02-auth/TD-06`)
2. Adicionar `POST /videos/:id/upload/complete` ao `VideosController` — `findOwnedVideoOrThrow`, `reserveControlCall` do SI-03.9 antes de qualquer chamada ao storage (`UPLOAD_CONTROL_RATE_EXCEEDED`, per `phase-03-videos/TD-13`), delega a `VideoCompletionService.complete` e traduz o desfecho em `200` (`{ id, processing_status }`) ou `202` com header `Retry-After: 60` — um cliente que respeita esse intervalo faz no máximo 60 chamadas de conclusão por hora, abaixo do teto compartilhado de 120 (per `phase-03-videos/TD-02`, `phase-03-videos/TD-13`)
3. Documentar a rota no OpenAPI com as respostas `200`, `202`, `400`, `404`, `409` e `503` e o envelope de erro; regenerar `openapi.json` (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `CompleteUploadDto` (validador de ordem crescente) | Unit | `src/videos/dto/complete-upload.dto.spec.ts` |

**Dependencies:** SI-03.10 (serviço de conclusão)

**Acceptance criteria:**

- `POST /videos/:id/upload/complete` com o manifesto correto retorna `200` com `processing_status: "uploaded"`.
- A mesma chamada repetida depois retorna `200` com o status atual, sem criar outro job.
- Uma chamada enquanto o vídeo está `completing` retorna `202` com header `Retry-After`.
- Um manifesto fora de ordem retorna `400` com `error: "VALIDATION_ERROR"`; um manifesto que diverge do storage retorna `409` com `error: "UPLOAD_PARTS_MISMATCH"` e `message` citando os números das partes.
- O mesmo endpoint chamado por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`.
- Depois de 120 chamadas de status e conclusão do mesmo vídeo na janela de uma hora, `POST /videos/:id/upload/complete` retorna `429` com `error: "UPLOAD_CONTROL_RATE_EXCEEDED"` sem chamar o storage; nenhuma rota de vídeo recebe `429` do throttler de autenticação.
- O bloqueio não é permanente: depois que a janela de uma hora vence, a mesma conclusão de um upload legítimo (ainda dentro de `upload_expires_at`) retorna `200` e o vídeo chega a `uploaded`; o `429` nunca altera `processing_status` nem libera a reserva.

_Cobertura exigida dos testes de endpoint (para `/plan-test-specs`): o limite compartilhado de 120 chamadas/hora entre `GET /videos/:id/upload` e esta rota; a conclusão bem-sucedida de um upload legítimo depois de polling intensivo, sem bloqueio permanente; a conclusão ambígua mantendo `completing`; nenhuma liberação de reserva com resultado `indeterminate`._

---

### SI-03.12 — Infra: entrypoint do worker e serviço Compose `worker`

**Description:** Cria o segundo entrypoint do `nestjs-project` e o serviço `worker` com FFmpeg, usuário não-root, limites de recurso e parada graciosa, sem portas publicadas.

**Technical actions:**

1. Criar `src/worker/worker.module.ts` e `src/worker/main.worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` (sem HTTP), importando `ConfigModule`, `TypeOrmModule`, `StorageModule` e `QueueModule`; `enableShutdownHooks()` para que `SIGTERM` chame `boss.stop()` gracioso (per `phase-03-videos/TD-06`, `phase-03-videos/TD-05`)
2. Adicionar `nestjs-project/docker/worker/Dockerfile` — base `node` igual à do `Dockerfile.dev`, pacote `ffmpeg` do Debian com versão fixada, usuário não-root sem shell de login, comando `node dist/worker/main.worker.js` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`)
3. Adicionar o serviço `worker` ao `compose.yaml` — mesmo código montado, sem `ports`, `depends_on` de `db` e `minio` com `service_healthy`, `deploy.resources.limits` de CPU e memória, ambiente compartilhado com a API; incluir o script `start:worker` em `package.json` e o entrypoint no `nest-cli.json` (per `phase-03-videos/TD-16`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.4 (storage), SI-03.5 (fila)

**Acceptance criteria:**

- `docker compose up -d worker` deixa o serviço em execução sem nenhuma porta publicada (`docker compose port worker` vazio).
- `docker compose exec worker ffprobe -version` e `ffmpeg -version` respondem com a versão fixada.
- O processo do worker roda com usuário diferente de `root`.
- `docker compose stop worker` termina o processo dentro do timeout de parada, sem job deixado em estado ativo sem dono.

---

### SI-03.13 — Probe de mídia, regra de formato e thumbnail (Verification Gate 6)

**Description:** Implementa o `ffprobe`/`ffmpeg` via `spawn` com argumentos fixos e limites, a regra de mídia aceita decidida pelo probe e a geração do thumbnail, com fixtures que provam a regra sem confiar na extensão (Gate 6).

**Technical actions:**

1. Criar `src/media/ffprobe.runner.ts` e `src/media/ffmpeg.runner.ts` — `spawn` com lista fixa de argumentos (nunca shell), `-rw_timeout` em microssegundos, `-probesize`/`-analyzeduration` limitados, timeout de relógio `MEDIA_PROBE_TIMEOUT_SECONDS` que mata o processo, saída JSON parseada; stderr e mensagens de erro passam por `redactPresignedUrl` antes de qualquer log (per `phase-03-videos/TD-07`, `phase-03-videos/TD-13`)
2. Criar `src/media/media-rule.ts` — aceita somente: `format_name` contendo `mp4` **e** `major_brand` na allowlist da família MP4 (`isom`, completada pelas fixtures), primeiro stream de vídeo `h264` com `pix_fmt` `yuv420p`, áudio ausente ou `aac`, duração > 0; todo o resto → `UNSUPPORTED_FORMAT` permanente; mídia válida e suportada com duração acima de `MAX_VIDEO_DURATION_SECONDS` → `DURATION_LIMIT_EXCEEDED` permanente (código distinto, per `phase-03-videos/TD-07` revisão de 2026-11-11); classifica erro de storage/rede como transitório pelo padrão de stderr ou por `HeadObject` prévio, nunca pelo exit code (per `phase-03-videos/TD-07`)
3. Criar `src/media/thumbnail-policy.ts` — posição = 10% da duração limitada a [1 s, 10 s], e 0 s para clipes com menos de 2 s; `ffmpeg` grava um JPEG em diretório temporário por job, removido em `finally` em sucesso e falha (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`)
4. Criar `src/media/media.module.ts` e as fixtures em `test/fixtures/media/` geradas por script reprodutível `test/fixtures/media/generate.sh` (ffmpeg no container do worker): aceitas — H.264+AAC `faststart`, H.264 sem áudio, `moov` no fim; rejeitadas — HEVC, VP9/WebM, MKV salvo como `.mp4`, MOV, 3GP, H.264 4:4:4, áudio MP3, MP4 truncado, bytes aleatórios, texto (per `phase-03-videos/TD-15`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `media-rule.ts` | Unit: cada regra de aceitação/rejeição sobre JSON de probe | `src/media/media-rule.spec.ts` |
| `thumbnail-policy.ts` | Unit: posição por duração | `src/media/thumbnail-policy.spec.ts` |
| `redactPresignedUrl` | Unit: remove URL e todo parâmetro `X-Amz-*` | `src/media/redact.spec.ts` |
| Runners + fixtures reais (ffprobe/ffmpeg do container) | Integration: Gate 6 — cada fixture classificada corretamente, timeout mata o processo | `src/media/media-probe.integration-spec.ts` |

**Dependencies:** SI-03.12 (FFmpeg no container do worker)

**Acceptance criteria:**

- As fixtures H.264+AAC, H.264 sem áudio e `moov` no fim são aceitas, com `duration_seconds` > 0 e metadados de container e streams preenchidos (Gate 6).
- O MKV salvo como `.mp4`, o MOV, o 3GP, o HEVC, o VP9, o H.264 4:4:4, o áudio MP3, o MP4 truncado, os bytes aleatórios e o arquivo de texto resultam em `UNSUPPORTED_FORMAT` (Gate 6).
- Uma fixture aceita com duração acima de `MAX_VIDEO_DURATION_SECONDS` (override pequeno) resulta em `DURATION_LIMIT_EXCEEDED`, não em `UNSUPPORTED_FORMAT`.
- Um probe que ultrapassa `MEDIA_PROBE_TIMEOUT_SECONDS` (override pequeno) tem o processo encerrado e o erro classificado como transitório.
- Depois de um probe com falha, o diretório temporário do job não existe mais.
- Nenhuma mensagem de erro ou log produzido pelos runners contém `X-Amz-Signature` ou a URL assinada.

---

### SI-03.14 — Worker de processamento do vídeo

**Description:** Consome `video.process`, leva o vídeo de `uploaded` a `ready` ou `failed` com metadados e thumbnail, de forma idempotente e com retry só para erros transitórios.

**Technical actions:**

1. Criar `src/worker/video-processing.worker.ts` — `boss.work('video.process', { localConcurrency: WORKER_CONCURRENCY }, handler)`; claim curto `uploaded → processing` (ou re-claim de `processing` em retry) incrementando `processing_attempts` e gravando `processing_started_at`, fora de qualquer transação longa (per `phase-03-videos/TD-05` condição (8), `phase-03-videos/TD-09`)
2. No handler, a cada tentativa (primeira ou retry): ler a linha pelo `videoId` do payload (o job nunca carrega URL, chave derivada do cliente nem credencial), revalidar as pré-condições (estado `uploaded`/`processing`, `HeadObject` do original presente com `ContentLength = declared_size_bytes`), e só então gerar `presignInternalGet` com `PROCESSING_INPUT_PRESIGN_TTL_SECONDS` (default 3600 > `WORKER_JOB_TIMEOUT_SECONDS` 1800, validado na inicialização pelo SI-03.2) → probe e regra de mídia (SI-03.13) → thumbnail enviado por `PutObject` a `videos/<id>/thumbnail.jpg` → numa transação curta, `processing → ready` com `duration_seconds`, `media_metadata` e `thumbnail_generated_at` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`, `phase-03-videos/TD-10`)
3. Erros: `UNSUPPORTED_FORMAT` ou `DURATION_LIMIT_EXCEEDED` → `failed` permanente, job concluído sem retry; erro transitório → lançar para o retry com backoff do `pg-boss`; retries esgotados → `failed`/`PROCESSING_FAILED`; `failure_reason` só com o código de domínio, nunca URL ou parâmetro de assinatura (per `phase-03-videos/TD-09`, `phase-03-videos/TD-13`)
4. Idempotência: entrega duplicada ou tardia em vídeo já `ready`/`failed` atualiza zero linhas e conclui o job; a mesma execução repetida sobrescreve as mesmas chaves (per `phase-03-videos/TD-05`, `phase-03-videos/TD-09`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingWorker` | Unit: ramos permanente/transitório/esgotado/duplicado (mocks) | `src/worker/video-processing.worker.spec.ts` |
| Worker + pg-boss + MinIO + PostgreSQL reais | Integration: `uploaded → ready` com thumbnail, fixture inválida → `failed`, entrega duplicada, redação de logs | `src/worker/video-processing.worker.integration-spec.ts` |

**Dependencies:** SI-03.10 (vídeos `uploaded` e jobs publicados), SI-03.13 (probe, regra e thumbnail)

**Acceptance criteria:**

- Um vídeo válido `uploaded` chega a `ready` com `duration_seconds`, `media_metadata` e `thumbnail_generated_at` preenchidos, e o objeto `videos/<id>/thumbnail.jpg` existe no storage.
- Um vídeo HEVC chega a `failed` com `failure_reason: "UNSUPPORTED_FORMAT"` após uma única tentativa.
- Um erro transitório na primeira tentativa e sucesso na segunda deixa o vídeo `ready` com `processing_attempts = 2`.
- Duas entregas do mesmo job deixam um único thumbnail e uma única transição para `ready`.
- O `data` do job persistido em `PGBOSS_SCHEMA` contém apenas `videoId`; em um retry, a URL de entrada usada é diferente da URL da primeira tentativa.
- Um retry de um vídeo cujo original foi removido do storage não executa o probe e termina sem marcar `ready`.
- Nenhuma linha de log do worker nem `failure_reason` persistido contém `X-Amz-` ou uma URL assinada.
- Durante o processamento de um vídeo, `pg_stat_activity` não mostra transação aberta pela conexão do worker.

---

### SI-03.15 — Reaper/reconciliador agendado

**Description:** Agenda `video.reconcile` pelo `pg-boss` e executa no worker as limpezas e reconciliações do TD-14, sempre por transições compare-and-set.

**Technical actions:**

1. Criar `src/worker/video-reconciler.worker.ts` e registrar, no start do worker, `boss.schedule('video.reconcile', '*/5 * * * *')` com `boss.work('video.reconcile', …)` (per `phase-03-videos/TD-14`, `phase-03-videos/TD-05`)
2. Expiração e reservas órfãs, sempre por `confirmUploadsGone(originalKey, [upload_id?], upload_binding_token)` (SI-03.4) sob o mesmo advisory lock por vídeo do SI-03.7: (a) `uploading` com `upload_expires_at` vencido → `aborted` → `uploading → expired` (libera a cota); `completed` → `resolveCompleting` do SI-03.10 (o objeto concluído segue a prova, nunca vira `expired`); `indeterminate` → nada muda e a cota continua reservada até a próxima execução; (b) reservas com `upload_id = NULL` há mais de 15 minutos (constante do reconciliador) — com `multipart_create_attempted_at` preenchido, uma sessão pode existir mesmo sem `upload_id` — → mesma investigação da chave exclusiva: `aborted` → apaga a reserva (o cliente nunca recebeu `upload_id`); `indeterminate` → reserva mantida. A lista vazia de `ListMultipartUploads` sozinha nunca autoriza `expired`, `cancelled` nem a liberação de cota (per `phase-03-videos/TD-14`, `phase-03-videos/TD-09`, `phase-03-videos/TD-02`)
3. Claims parados: vídeos `completing` com `completing_since` mais antigo que `COMPLETING_STALE_MINUTES` → `resolveCompleting` do SI-03.10 (prova de conclusão completa → `uploaded` + job; prova contradita → `failed`/`UPLOAD_INVALID`; perda definitiva → `failed`/`UPLOAD_LOST` ou `expired`; ambíguo → sem transição) (per `phase-03-videos/TD-02` revisão IC-1)
4. Entrega garantida: vídeos `uploaded` sem job `video.process` ativo → `publishVideoProcess` com `singletonKey` = id (per `phase-03-videos/TD-02` linha "Queue publish fails after the commit"; obrigatório no caminho fallback do SI-03.1)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoReconcilerWorker` | Unit: seleção por limiar, cada ramo de ação (mocks) | `src/worker/video-reconciler.worker.spec.ts` |
| Reconciliador + MinIO + PostgreSQL + pg-boss reais | Integration: upload expirado abortado, claim parado resolvido, job republicado | `src/worker/video-reconciler.worker.integration-spec.ts` |

**Dependencies:** SI-03.10 (`resolveCompleting`), SI-03.12 (entrypoint do worker)

**Acceptance criteria:**

- Um vídeo `uploading` com `upload_expires_at` no passado passa a `expired`, e `ListParts` do seu `upload_id` responde `NoSuchUpload`.
- Uma reserva com `upload_id = NULL` e um multipart órfão na chave do vídeo é apagada só depois que o abort é repetido até `ListParts` responder `NoSuchUpload` e o `HeadObject` responder `404`; com o storage inacessível, continua existindo e contando na cota.
- Um vídeo `uploading` vencido cujo objeto já foi concluído com o binding esperado não vira `expired`: segue pela prova de conclusão e chega a `uploaded`.
- Uma parte enviada para uma sessão durante o primeiro abort não impede a limpeza: o abort é repetido e só então o vídeo passa a `expired`.
- Um vídeo `completing` parado há mais de `COMPLETING_STALE_MINUTES` (override pequeno) cujo objeto satisfaz a prova de conclusão do SI-03.10 passa a `uploaded` e ganha um job `video.process`.
- Um vídeo `completing` parado cujo storage está inacessível continua `completing`.
- Um vídeo `uploaded` sem job recebe exatamente um job `video.process` após uma execução do reconciliador, e uma segunda execução não cria outro.
- Duas execuções sobrepostas do reconciliador não produzem transições duplicadas.

---

### SI-03.16 — URLs de reprodução e download (Verification Gates 7 e 8)

**Route:** GET /videos/:id/playback-url, GET /videos/:id/download-url
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner, `ready` only — ver §Authorization Matrix

**Description:** Emite URLs presignadas de streaming e download só para o dono de um vídeo `ready`, e prova no MinIO real o `Range` direto e a expiração/renovação (Gates 7 e 8).

**Technical actions:**

1. Criar `src/videos/video-delivery.service.ts` — `playbackUrl(video)` com `PLAYBACK_PRESIGN_TTL_SECONDS` e `downloadUrl(video)` com `DOWNLOAD_PRESIGN_TTL_SECONDS` e `ResponseContentDisposition: attachment` com `original_filename` codificado por RFC 6266, ambos no endpoint público; vídeo não `ready` → `VIDEO_NOT_READY`; antes de assinar, reserva atômica na janela de uma hora (`UPDATE … SET delivery_urls_issued = CASE WHEN delivery_window_started_at < now() - interval '1 hour' OR delivery_window_started_at IS NULL THEN 1 ELSE delivery_urls_issued + 1 END, delivery_window_started_at = … WHERE … AND (janela vencida OR delivery_urls_issued < 60) RETURNING`; zero linhas → `DELIVERY_URL_LIMIT_EXCEEDED`) (per `phase-03-videos/TD-11` revisão IC-2, `phase-03-videos/TD-13`)
2. Adicionar as duas rotas ao `VideosController` com `Cache-Control: no-store`, resposta `{ url, expires_at }` e documentação OpenAPI; regenerar `openapi.json` (per `phase-03-videos/TD-11`, `openapi-docs-nestjs/TD-01`)
3. Criar `src/videos/video-delivery.storage.integration-spec.ts` — testes de storage com `fetch` puro contra as URLs emitidas: `206` com `Content-Range`/`Content-Length`/`Accept-Ranges` para um range válido, `200` para range inválido, `416` para range insatisfazível (sem afirmar `Content-Range`), `Content-Disposition` na URL de download, `403` após a expiração (TTL de override pequeno) e para requisição não assinada (per `phase-03-videos/TD-11`, `phase-03-videos/TD-15`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoDeliveryService` | Unit: `ready` only, TTL por tipo, `Content-Disposition` RFC 6266 | `src/videos/video-delivery.service.spec.ts` |
| URLs emitidas × MinIO real | Integration (storage-level `fetch`): Gate 8 — `Range` direto; Gate 7 — expiração e renovação | `src/videos/video-delivery.storage.integration-spec.ts` |

**Dependencies:** SI-03.14 (vídeos `ready`), SI-03.8 (controller)

**Acceptance criteria:**

- `GET /videos/:id/playback-url` pelo dono de um vídeo `ready` retorna `200` com `{ url, expires_at }`, `Cache-Control: no-store`, e o corpo não contém `S3_SECRET_ACCESS_KEY` nem `S3_ACCESS_KEY_ID`.
- Um `GET` com `Range: bytes=0-1023` na URL emitida retorna `206` com `Content-Range: bytes 0-1023/<tamanho>` (Gate 8).
- Com `PLAYBACK_PRESIGN_TTL_SECONDS` de override pequeno, a URL responde `403` depois de `expires_at`, e uma nova URL pedida em seguida retoma o `Range` a partir do mesmo byte (Gate 7).
- A URL de `GET /videos/:id/download-url` responde com `Content-Disposition: attachment` contendo o nome original sanitizado.
- Os dois endpoints com o vídeo em `processing` retornam `409` com `error: "VIDEO_NOT_READY"`; por outro usuário, `404` com `error: "VIDEO_NOT_FOUND"`.
- A 61ª URL de reprodução ou download do mesmo vídeo dentro de uma hora retorna `429` com `error: "DELIVERY_URL_LIMIT_EXCEEDED"`; depois que a janela vence, uma nova URL é emitida.

---

### SI-03.17 — Verificação ponta a ponta de 10 GiB (Verification Gate 3)

**Description:** Demonstra, na infraestrutura Compose real, upload multipart, retomada, conclusão e processamento de um arquivo no limite `MAX_UPLOAD_BYTES` (10 GiB), sem o tráfego passar pela API, e registra a evidência (Gate 3).

**Technical actions:**

1. Criar `nestjs-project/scripts/verify-large-upload.ts` — gera (ou reutiliza) um MP4 H.264 válido de `MAX_UPLOAD_BYTES` em disco temporário, chama `POST /videos`, envia as 160 partes em paralelo limitado pelas URLs emitidas, interrompe o envio no meio, retoma por `GET /videos/:id/upload`, conclui e acompanha `GET /videos/:id` até `ready` ou `failed` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`, `phase-03-videos/TD-13`)
2. Expor o script como `npm run verify:large-upload` (fora de `npm test`, `test:e2e` e de qualquer projeto Jest, para não entrar na suíte cotidiana); medir e registrar memória RSS de `nestjs-api` durante o envio (o corpo não passa pela API), duração de cada etapa e tempo de probe e de thumbnail lendo por `Range`; o arquivo é gerado por comando `ffmpeg` determinístico registrado no relatório, com o SHA-256 do arquivo gerado; o script recusa rodar fora do bucket e do schema de teste
3. Registrar o resultado em `docs/phases/phase-03-videos/verification-10gib.md` — ambiente, versões, tamanhos, tempos, memória, cada condição PASS/FAIL; se a leitura por `Range` se mostrar insuficiente, o documento registra a necessidade da Option C do TD-08 (cópia local) como achado, sem implementá-la (per `phase-03-videos/TD-08`)

**Tests:** _(empty — verification script run on demand; the evidence report is the deliverable)_

**Dependencies:** SI-03.11 (conclusão por HTTP), SI-03.14 (processamento), SI-03.15 (reconciliador ativo)

**Acceptance criteria:**

- Um upload de exatamente `10737418240` bytes chega a `ready` com `duration_seconds` e thumbnail.
- O upload interrompido e retomado envia apenas as partes listadas em `missing_part_numbers`, e a conclusão estabelece a prova do SI-03.10 (chave exclusiva, `upload_id`, manifesto do `ListParts`, tamanho e `upload-binding`).
- `npm test` e `npm run test:e2e` não executam a verificação de 10 GiB; `verification-10gib.md` contém o comando de geração, o SHA-256 do arquivo e as versões, suficientes para repetir a execução.
- A memória RSS de `nestjs-api` durante o envio não cresce proporcionalmente ao arquivo (variação abaixo de 100 MiB).
- Um `POST /videos` com `size_bytes = 10737418241` retorna `400` com `error: "UPLOAD_SIZE_EXCEEDED"`.
- `verification-10gib.md` existe e marca a condição 3 da tabela de gates como PASS ou FAIL com a evidência.

---

## Technical Specifications

### Data Model

#### Video (table `videos`)

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated — the **only** source of storage keys (per phase-03-videos/TD-10) |
| public_id | varchar(11) | unique, not null — random base62 of 11 characters (62^11 ≈ 5.2 × 10^19), generated at the draft step, the identifier used in every URL (per phase-03-videos/TD-10) |
| channel_id | uuid | FK → `channels.id`, not null — the owning channel (per phase-03-videos/TD-12) |
| publication | enum `video_publication` (`draft`) | not null, default `draft` — Phase 03 only ever writes `draft`; Phase 04 adds the published value (per phase-03-videos/TD-09, boundary AMB-1) |
| processing_status | enum `video_processing_status` (`uploading`, `completing`, `uploaded`, `processing`, `ready`, `failed`, `expired`, `cancelled`) | not null — lifecycle per the TD-09 transition table; every write is compare-and-set (per phase-03-videos/TD-09) |
| failure_reason | varchar(64) | nullable — domain code only (`UPLOAD_LOST`, `UPLOAD_INVALID`, `UNSUPPORTED_FORMAT`, `DURATION_LIMIT_EXCEEDED`, `PROCESSING_FAILED`); never a URL or signature parameter (per phase-03-videos/TD-09, phase-03-videos/TD-13) |
| idempotency_key | varchar(128) | not null — client-supplied start key (per phase-03-videos/TD-02) |
| original_filename | varchar(255) | not null — sanitized (paths and control characters stripped), used only for `Content-Disposition` (per phase-03-videos/TD-10, phase-03-videos/TD-13) |
| content_type_hint | varchar(127) | nullable — advisory MIME from the client, never proof of format (per phase-03-videos/TD-13) |
| declared_size_bytes | bigint | not null, `> 0`, `<= MAX_UPLOAD_BYTES` checked at start (per phase-03-videos/TD-13) |
| part_size_bytes | bigint | not null — `UPLOAD_PART_SIZE_BYTES` at start (per phase-03-videos/TD-01) |
| expected_part_count | integer | not null, `1..10000` (per phase-03-videos/TD-01) |
| upload_id | varchar(1024) | nullable — the S3 multipart upload id; `NULL` only while the start reservation exists and `CreateMultipartUpload` has not been confirmed (per phase-03-videos/TD-02) |
| multipart_create_attempted_at | timestamptz | nullable — committed **before** each `CreateMultipartUpload` call; evidence for the reconciler that a session may exist under the key even with `upload_id = NULL` (per phase-03-videos/TD-02, phase-03-videos/TD-14) |
| upload_binding_token | varchar(64) | not null — random server-generated token written as object metadata `x-amz-meta-upload-binding` at `CreateMultipartUpload`; binds the final object to this authorized session (per phase-03-videos/TD-02) |
| part_urls_issued | integer | not null, default `0` — cumulative part URLs issued for this upload; capped at `10 × expected_part_count` (abuse control, per phase-03-videos/TD-13) |
| delivery_urls_issued | integer | not null, default `0` — playback/download URLs issued in the current window (abuse control, per phase-03-videos/TD-13) |
| delivery_window_started_at | timestamptz | nullable — start of the one-hour delivery-URL window (per phase-03-videos/TD-13) |
| control_calls_issued | integer | not null, default `0` — `GET /videos/:id/upload` + `POST /videos/:id/upload/complete` calls in the current window (abuse control, per phase-03-videos/TD-13) |
| control_window_started_at | timestamptz | nullable — start of the one-hour control-call window (per phase-03-videos/TD-13) |
| upload_expires_at | timestamptz | not null — `created_at + UPLOAD_EXPIRY_HOURS` (per phase-03-videos/TD-02, phase-03-videos/TD-14) |
| completing_since | timestamptz | nullable — set by the `uploading → completing` claim (per phase-03-videos/TD-02) |
| duration_seconds | numeric(12,3) | nullable — from `ffprobe` (per phase-03-videos/TD-07) |
| media_metadata | jsonb | nullable — probe summary: `format_name`, `major_brand`, video `codec_name`/`width`/`height`/`pix_fmt`, audio `codec_name` or null, `bit_rate`, `size` (per phase-03-videos/TD-07) |
| thumbnail_generated_at | timestamptz | nullable — set when `videos/<uuid>/thumbnail.jpg` is stored (per phase-03-videos/TD-07, phase-03-videos/TD-10) |
| processing_attempts | integer | not null, default `0` (per phase-03-videos/TD-09) |
| processing_started_at | timestamptz | nullable (per phase-03-videos/TD-09) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), updated on change |

**Relations:** `Channel` has many `Video` (one-to-many, `videos.channel_id`); `Video` belongs to one `Channel`.
**Indexes:** unique on `public_id`; unique on (`channel_id`, `idempotency_key`) (start idempotency, per phase-03-videos/TD-02); index on (`channel_id`, `processing_status`) (active-upload and pending-bytes checks, per phase-03-videos/TD-13); index on (`processing_status`, `upload_expires_at`) and on (`processing_status`, `completing_since`) (reaper scans, per phase-03-videos/TD-14); index on (`channel_id`, `created_at`) (start-rate check, per phase-03-videos/TD-13).
**Owner serialization:** quotas are per owner (the user). Today `channels.user_id` is `UNIQUE` (one channel per user), but every quota check locks the owner's `users` row (`SELECT … FROM users WHERE id = $1 FOR UPDATE`) and sums over **all** channels of that user, so the rule stays correct if multi-channel ownership is ever introduced.
**Quota accounting:** a row counts toward `MAX_ACTIVE_UPLOADS_PER_OWNER` and `MAX_PENDING_UPLOAD_BYTES_PER_OWNER` from the moment its reservation is inserted (`uploading`, `upload_id` possibly `NULL`) until it reaches `uploaded`, `failed`, `expired` or `cancelled`; the transitions to `expired` and `cancelled` (and the deletion of an unconfirmed reservation) happen only when `confirmUploadsGone` (SI-03.4) returns `aborted`, so capacity is never released while a multipart upload may still be open or its outcome is indeterminate (per phase-03-videos/TD-13 revision AMB-2, phase-03-videos/TD-14).
**Storage keys (derived, not stored):** `videos/<id>/original` and `videos/<id>/thumbnail.jpg`, built from `id` only — never from `public_id` or the client filename (per phase-03-videos/TD-10).

#### pg-boss queue schema

Not a TypeORM entity. The `pg-boss` tables live in the schema named by `PGBOSS_SCHEMA` (tests: `PGBOSS_TEST_SCHEMA`), created deterministically by the mechanism the spike selects (library installation or DDL from `getConstructionPlans()` applied by a migration) and reset only through a guard that refuses any non-test schema (per phase-03-videos/TD-05, phase-03-videos/TD-15).

### API Contracts

All endpoints below are authenticated by the existing global `JwtAuthGuard` (none is `@Public()`), carry `@SkipThrottle()` on their controller (per phase-03-videos/TD-13 revision ICC-1), resolve the video by `public_id`, and answer errors with the inherited envelope `{ statusCode, error, message }` (per phase-02-auth/TD-07). Responses that carry a presigned URL also send `Cache-Control: no-store` and never contain permanent credentials (per phase-03-videos/TD-11). An unknown video or a video of another channel always answers 404 `VIDEO_NOT_FOUND` (per phase-03-videos/TD-12).

#### POST /videos (SI-03.6)

Starts an upload: creates the private draft and the S3 multipart upload (per phase-03-videos/TD-01, phase-03-videos/TD-02).

**Request headers:**
- Content-Type: application/json
- Idempotency-Key: string, required — 1..128 printable ASCII characters; unique per channel (per phase-03-videos/TD-02)

**Request body:**
- filename: string, required — 1..255 characters; sanitized server-side (per phase-03-videos/TD-13)
- size_bytes: integer, required — `> 0` and `<= MAX_UPLOAD_BYTES` (per phase-03-videos/TD-13)
- content_type: string, optional — advisory hint only (per phase-03-videos/TD-13)

**Response 201:** (first call) — **Response 200:** (retry with the same `Idempotency-Key`: the same video and upload, never a second draft or multipart upload, per phase-03-videos/TD-02)
- id: string — `public_id`
- upload_id: string
- part_size_bytes: integer
- expected_part_count: integer
- upload_expires_at: string (ISO-8601)
- processing_status: `uploading`
- publication: `draft`

**Error responses:**
- 400 VALIDATION_ERROR: when the body or the `Idempotency-Key` header fails validation
- 400 UPLOAD_SIZE_EXCEEDED: when `size_bytes` is greater than `MAX_UPLOAD_BYTES`
- 403 CHANNEL_REQUIRED: when the authenticated user has no channel
- 409 IDEMPOTENCY_KEY_CONFLICT: when the key was already used with a different `filename` or `size_bytes`
- 429 ACTIVE_UPLOAD_LIMIT_EXCEEDED: when the channel already has `MAX_ACTIVE_UPLOADS_PER_OWNER` uploads in `uploading`/`completing`
- 429 PENDING_UPLOAD_QUOTA_EXCEEDED: when `size_bytes` would push the channel's pending bytes above `MAX_PENDING_UPLOAD_BYTES_PER_OWNER` (per phase-03-videos/TD-13 revision AMB-2)
- 429 UPLOAD_START_RATE_EXCEEDED: when the channel already created 20 videos in the last hour (counted in PostgreSQL; per phase-03-videos/TD-13)
- 409 UPLOAD_START_IN_PROGRESS: when another request is creating the multipart upload for the same reservation (per-video advisory lock held); sends `Retry-After`
- 503 STORAGE_UNAVAILABLE: when storage cannot create the multipart upload; sends `Retry-After`. A **definitive** storage rejection deletes the reservation in the same request (no multipart exists). An **ambiguous** failure (timeout, reset, 5xx, lost response) keeps the reservation; a retry with the same `Idempotency-Key`, or the reconciler, investigates the exclusive key and releases the capacity only after `confirmUploadsGone` returns `aborted`
- 401: when the request is not authenticated (guard default)

---

#### POST /videos/:id/upload/part-urls (SI-03.6)

Issues presigned `UploadPart` URLs for a batch of part numbers; re-requestable at any time before expiry (per phase-03-videos/TD-01, phase-03-videos/TD-13).

**Request headers:**
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1..100 distinct values, each in `1..expected_part_count`

**Response 200:**
- parts: array of `{ part_number: integer, url: string, expires_at: string (ISO-8601) }` — URLs signed for `S3_PUBLIC_ENDPOINT` with `UPLOAD_PART_PRESIGN_TTL_SECONDS` (per phase-03-videos/TD-04, phase-03-videos/TD-13 revision IC-2)

**Error responses:**
- 400 VALIDATION_ERROR: when `part_numbers` is missing, empty, too long, duplicated or out of range
- 404 VIDEO_NOT_FOUND: unknown video or another channel's video
- 409 INVALID_VIDEO_STATE: when `processing_status` is not `uploading`
- 409 UPLOAD_EXPIRED: when `upload_expires_at` has passed
- 429 PART_URL_LIMIT_EXCEEDED: when issuing the batch would push `part_urls_issued` above `10 × expected_part_count` (atomic counter in PostgreSQL; per phase-03-videos/TD-13)
- 401: when the request is not authenticated

---

#### GET /videos/:id/upload (SI-03.6)

Status/resume: lists the parts storage already holds, using paginated `ListParts` (per phase-03-videos/TD-01, phase-03-videos/TD-02).

**Response 200:**
- processing_status: string
- part_size_bytes: integer
- expected_part_count: integer
- upload_expires_at: string (ISO-8601)
- parts: array of `{ part_number: integer, size_bytes: integer, etag: string }`
- missing_part_numbers: integer[]

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown video or another channel's video
- 409 INVALID_VIDEO_STATE: when `processing_status` is not `uploading` or `completing`
- 429 UPLOAD_CONTROL_RATE_EXCEEDED: when the video already had 120 status/complete calls in the current one-hour window (atomic counter in PostgreSQL, shared with `complete`; per phase-03-videos/TD-13)
- 503 STORAGE_UNAVAILABLE: when `ListParts` fails with a transport error; sends `Retry-After`
- 401: when the request is not authenticated

---

#### POST /videos/:id/upload/complete (SI-03.7)

Completes the upload with the client's ordered manifest, following the TD-02 completion protocol (verify → claim → `CompleteMultipartUpload` → identity proof → transition + enqueue).

**Request headers:**
- Content-Type: application/json

**Request body:**
- parts: array, required — exactly `expected_part_count` entries of `{ part_number: integer, etag: string }`, part numbers strictly ascending `1..N`, `etag` well formed (per phase-03-videos/TD-02)

**Response 200:** (the video is past `uploading`: `uploaded`, `processing` or `ready`; also the answer to a repeated call)
- id: string
- processing_status: string

**Response 202:** (the row is `completing` and the outcome is not yet proven — per the TD-02 ambiguity rule)
- id: string
- processing_status: `completing`
- header `Retry-After`: seconds

**Error responses:**
- 400 VALIDATION_ERROR: when the manifest is malformed (not ascending, wrong length, malformed `etag`)
- 404 VIDEO_NOT_FOUND: unknown video or another channel's video
- 409 UPLOAD_PARTS_MISMATCH: when `ListParts` disagrees with the manifest (missing, extra, mis-sized or `ETag`-mismatched parts); `message` names the part numbers and the client resumes through `GET /videos/:id/upload`; `Complete` is not called
- 409 UPLOAD_EXPIRED: when `upload_expires_at` has passed
- 409 INVALID_VIDEO_STATE: when the video is terminal (`failed`, `expired`, `cancelled`)
- 429 UPLOAD_CONTROL_RATE_EXCEEDED: shared one-hour window with `GET /videos/:id/upload`; checked before any storage call (per phase-03-videos/TD-13)
- 503 STORAGE_UNAVAILABLE: when storage is unreachable **before** the claim; nothing is claimed; sends `Retry-After`; no cached fallback (per phase-03-videos/TD-02)
- 401: when the request is not authenticated

---

#### DELETE /videos/:id/upload (SI-03.6)

Aborts an incomplete upload: `AbortMultipartUpload` (repeated until `ListParts` is empty) and `uploading → cancelled`; the abort also invalidates outstanding part URLs (per phase-03-videos/TD-09, phase-03-videos/TD-13).

**Response 204:** No content. (Also answered when the video is already `cancelled`.)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown video or another channel's video
- 409 INVALID_VIDEO_STATE: when `processing_status` is not `uploading` (completing or completed uploads cannot be cancelled in this phase)
- 503 STORAGE_UNAVAILABLE: when storage cannot be reached; the row is not changed; sends `Retry-After`
- 401: when the request is not authenticated

---

#### GET /videos/:id (SI-03.6)

Owner-only status of the draft (per phase-03-videos/TD-12, phase-03-videos/TD-15 "status" operation). No per-call counter: it is a single indexed read with no storage call, and writing a counter on every read would cost more than the read it limits; the global authentication throttler is not reintroduced here.

**Response 200:**
- id: string — `public_id`
- publication: `draft`
- processing_status: string
- failure_reason: string | null
- original_filename: string
- size_bytes: integer
- duration_seconds: number | null
- media_metadata: object | null
- has_thumbnail: boolean
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown video or another channel's video
- 401: when the request is not authenticated

---

#### GET /videos/:id/playback-url (SI-03.11)

Emits a presigned GET for streaming; storage answers `Range` requests directly (per phase-03-videos/TD-11).

**Response 200:** (with `Cache-Control: no-store`)
- url: string — presigned for `S3_PUBLIC_ENDPOINT` with `PLAYBACK_PRESIGN_TTL_SECONDS` (per phase-03-videos/TD-11 revision IC-2)
- expires_at: string (ISO-8601) — the client requests a new URL before this instant and keeps the playback position

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown video or another channel's video
- 409 VIDEO_NOT_READY: when `processing_status` is not `ready`
- 429 DELIVERY_URL_LIMIT_EXCEEDED: when the video already had 60 playback/download URLs issued in the current one-hour window (atomic counter in PostgreSQL, shared with `download-url`; per phase-03-videos/TD-13)
- 401: when the request is not authenticated

---

#### GET /videos/:id/download-url (SI-03.11)

Emits a presigned GET that forces download with the sanitized original filename (per phase-03-videos/TD-11, phase-03-videos/TD-13).

**Response 200:** (with `Cache-Control: no-store`)
- url: string — presigned for `S3_PUBLIC_ENDPOINT` with `DOWNLOAD_PRESIGN_TTL_SECONDS` and `ResponseContentDisposition: attachment` with the RFC 6266-encoded `original_filename` (per phase-03-videos/TD-11 revision IC-2)
- expires_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown video or another channel's video
- 409 VIDEO_NOT_READY: when `processing_status` is not `ready`
- 429 DELIVERY_URL_LIMIT_EXCEEDED: shared one-hour window with `playback-url` (per phase-03-videos/TD-13)
- 401: when the request is not authenticated

---

#### Validation Rules — videos

- `Idempotency-Key`: required on `POST /videos`, 1..128 printable ASCII characters.
- `filename`: required, 1..255 characters before sanitization; the stored value strips path segments and control characters.
- `size_bytes`: required integer, `> 0`; the `MAX_UPLOAD_BYTES` ceiling is a domain check (`UPLOAD_SIZE_EXCEEDED`), not a DTO constant, so it follows configuration.
- `part_numbers`: required, 1..100 distinct integers in `1..expected_part_count`.
- `parts` (complete): exactly `expected_part_count` entries, strictly ascending from 1, `etag` matching a quoted or unquoted hex digest with an optional `-N` suffix.
- `:id`: a base62 string of the `public_id` length; anything else is answered 404 `VIDEO_NOT_FOUND` (never 400, so existence is not revealed).

### Authorization Matrix

Ownership is decided by one policy function (video's `channel_id` = the authenticated user's channel) so Phases 04–05 can extend it (per phase-03-videos/TD-12). "Authenticated" below means an authenticated user who does **not** own the video.

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ 401 | ✓ (creates under the caller's own channel; 403 `CHANNEL_REQUIRED` without a channel) | — |
| POST /videos/:id/upload/part-urls | ✗ 401 | ✗ 404 | ✓ while `uploading` |
| GET /videos/:id/upload | ✗ 401 | ✗ 404 | ✓ while `uploading`/`completing` |
| POST /videos/:id/upload/complete | ✗ 401 | ✗ 404 | ✓ |
| DELETE /videos/:id/upload | ✗ 401 | ✗ 404 | ✓ while `uploading` |
| GET /videos/:id | ✗ 401 | ✗ 404 | ✓ |
| GET /videos/:id/playback-url | ✗ 401 | ✗ 404 | ✓ `ready` only (else 409 `VIDEO_NOT_READY`) |
| GET /videos/:id/download-url | ✗ 401 | ✗ 404 | ✓ `ready` only (else 409 `VIDEO_NOT_READY`) |

Public access does not exist in Phase 03: `processing_status = ready` never implies publication (boundary AMB-1).

### Error Catalog

Envelope inherited from phase-02-auth/TD-07: `{ statusCode, error, message }`, thrown as `DomainException` subclasses and serialized by the existing `DomainExceptionFilter`; DTO failures keep `VALIDATION_ERROR` from the existing `ValidationExceptionFilter`.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Unknown `public_id`, malformed `:id`, or a video of another channel (per phase-03-videos/TD-12) |
| VIDEO_NOT_READY | 409 | Playback/download URL requested while `processing_status` ≠ `ready` (per phase-03-videos/TD-11) |
| STORAGE_UNAVAILABLE | 503 | Storage transport error before any state change; sends `Retry-After`; no cached fallback (per phase-03-videos/TD-02) |
| CHANNEL_REQUIRED | 403 | Start requested by a user without a channel |
| UPLOAD_SIZE_EXCEEDED | 400 | Declared `size_bytes` greater than `MAX_UPLOAD_BYTES` (per phase-03-videos/TD-13) |
| ACTIVE_UPLOAD_LIMIT_EXCEEDED | 429 | Channel already at `MAX_ACTIVE_UPLOADS_PER_OWNER` uploads in `uploading`/`completing` (per phase-03-videos/TD-13) |
| PENDING_UPLOAD_QUOTA_EXCEEDED | 429 | Declared size would push the channel's pending bytes above `MAX_PENDING_UPLOAD_BYTES_PER_OWNER` (per phase-03-videos/TD-13 revision AMB-2) |
| IDEMPOTENCY_KEY_CONFLICT | 409 | `Idempotency-Key` reused with a different `filename` or `size_bytes` (per phase-03-videos/TD-02) |
| INVALID_VIDEO_STATE | 409 | Upload operation not allowed in the current `processing_status` (per phase-03-videos/TD-09) |
| UPLOAD_EXPIRED | 409 | Upload operation after `upload_expires_at` (per phase-03-videos/TD-02, phase-03-videos/TD-14) |
| UPLOAD_PARTS_MISMATCH | 409 | `ListParts` disagrees with the completion manifest; `Complete` not called; the message names the part numbers (per phase-03-videos/TD-02) |
| UPLOAD_START_RATE_EXCEEDED | 429 | Channel created 20 videos in the last hour (counted in PostgreSQL, no Redis; per phase-03-videos/TD-13) |
| PART_URL_LIMIT_EXCEEDED | 429 | Part URLs issued for the upload would exceed `10 × expected_part_count` (per phase-03-videos/TD-13) |
| DELIVERY_URL_LIMIT_EXCEEDED | 429 | More than 60 playback/download URLs for the same video in a one-hour window (per phase-03-videos/TD-13) |
| UPLOAD_CONTROL_RATE_EXCEEDED | 429 | More than 120 `GET /videos/:id/upload` + `POST /videos/:id/upload/complete` calls for the same video in a one-hour window (per phase-03-videos/TD-13) |
| UPLOAD_START_IN_PROGRESS | 409 | A concurrent request holds the per-video lock while creating the multipart upload; sends `Retry-After` (per phase-03-videos/TD-02) |

The four abuse limits above are code constants (`src/videos/abuse-limits.ts`), not environment keys: TD-16's canonical key list is closed and is not extended by this plan.

`failure_reason` codes (stored on the row and returned by `GET /videos/:id`, never thrown as HTTP errors):

| failure_reason | Trigger |
|----------------|---------|
| UPLOAD_LOST | Upload definitively gone (`NoSuchUpload`), no valid object, `upload_expires_at` not passed (per phase-03-videos/TD-02 revision IC-1, phase-03-videos/TD-09) |
| UPLOAD_INVALID | The object at the video's key positively contradicts the completion proof (size differs from the declared size, or the `upload-binding` metadata differs from `upload_binding_token`); the object is deleted. A proof that merely cannot be established is **not** `UPLOAD_INVALID` — the row stays `completing` (per phase-03-videos/TD-02, phase-03-videos/TD-09) |
| UNSUPPORTED_FORMAT | Probe rejects the media (not MP4-family brand, not H.264 `yuv420p`, audio not AAC, duration 0, unreadable/invalid media); permanent, no retry (per phase-03-videos/TD-07) |
| DURATION_LIMIT_EXCEEDED | A valid, supported video whose duration exceeds `MAX_VIDEO_DURATION_SECONDS`; permanent, no retry. Functional restriction: with the default `14400`, a file within 10 GiB that lasts more than 4 h is rejected; `project-plan.md` sets only the 10 GB size limit, so this is an accepted, configurable restriction, not a scope contradiction. Formally approved by the `phase-03-videos/TD-07` revision of 2026-11-11 (decision A unchanged): a valid format that exceeds the duration limit is not an incompatible format; `UNSUPPORTED_FORMAT` stays reserved for media outside the accepted-format rule |
| PROCESSING_FAILED | Transient processing errors exhausted the queue retries (per phase-03-videos/TD-05, phase-03-videos/TD-09) |

### Events/Messages

#### video.process (pg-boss job)

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideoUploadService.complete` — enqueued with `send(…, { db })` inside the same transaction that commits `completing → uploaded`, with job key = video id; if Verification Gate 1 fails, the `uploaded` row is the durable intent and the reconciler re-publishes (per phase-03-videos/TD-05, phase-03-videos/TD-02)
**Consumer:** `VideoProcessingWorker` in the worker entrypoint — claims `uploaded → processing`, generates **at the start of each attempt** a presigned GET signed for `S3_ENDPOINT` (internal) with `PROCESSING_INPUT_PRESIGN_TTL_SECONDS`, probes, writes metadata and the thumbnail, then `processing → ready` or `failed` (per phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-08)
**Payload rule:** the persisted job carries only the internal `videoId`; it never contains a presigned URL, a storage key built from client input or any credential. Every attempt (first or retry) re-reads the row, re-checks the processing preconditions and presigns a fresh URL (per phase-03-videos/TD-07, phase-03-videos/TD-08 revision AMB-3)
**Trigger:** a successful, identity-proven completion (`uploaded`)
**Delivery semantics:** at-least-once — singleton key = video id deduplicates publication; the handler is idempotent (same outputs overwrite the same keys; duplicate or late deliveries update zero rows); retries with backoff for transient errors, `expireInSeconds` derived from `WORKER_JOB_TIMEOUT_SECONDS` (per phase-03-videos/TD-05, phase-03-videos/TD-09)

#### video.reconcile (pg-boss schedule)

**Payload:**

```json
{}
```

**Producer:** a `pg-boss` cron schedule registered by the worker at startup (per phase-03-videos/TD-14)
**Consumer:** `VideoReconcilerWorker` in the worker entrypoint — aborts and expires uploads past `upload_expires_at` and cleans unconfirmed reservations only when `confirmUploadsGone` returns `aborted` (an empty listing alone is never proof), resolves `completing` rows older than `COMPLETING_STALE_MINUTES` with evidence (identity proof → `uploaded`; definitive loss → `failed`/`expired`; ambiguous → unchanged), and re-publishes `video.process` for `uploaded` rows without a job (per phase-03-videos/TD-14, phase-03-videos/TD-02 revision IC-1)
**Trigger:** schedule (single active instance per schedule name)
**Delivery semantics:** at-least-once; every action is a compare-and-set transition, so overlapping or repeated runs are harmless (per phase-03-videos/TD-09, phase-03-videos/TD-14)

---

## Dependency Map

```
SI-03.1 (root — Gate 1 spike; decides transactional enqueue vs fallback)
SI-03.2 (root — configuration and environment contract)
├── SI-03.3 — depends on SI-03.2 (MinIO keys; Gate 2)
│   └── SI-03.4 — depends on SI-03.2, SI-03.3 (storage needs running MinIO)
└── SI-03.5 — depends on SI-03.1, SI-03.2 (queue follows the spike result)
SI-03.6 (root — Video entity and migration)

SI-03.4 + SI-03.6
└── SI-03.7 — start-upload service and access policy
    └── SI-03.8 — depends on SI-03.5, SI-03.7 (VideosModule + POST /videos, GET /videos/:id)
        └── SI-03.9 — part URLs, resume, abort
            └── SI-03.10 — depends on SI-03.5, SI-03.9 (completion; Gates 4 and 5)
                └── SI-03.11 — POST /videos/:id/upload/complete

SI-03.4 + SI-03.5
└── SI-03.12 — worker entrypoint and Compose service
    ├── SI-03.13 — media probe, rule and thumbnail (Gate 6)
    │   └── SI-03.14 — depends on SI-03.10, SI-03.13 (processing worker)
    │       └── SI-03.16 — depends on SI-03.14, SI-03.8 (playback/download URLs; Gates 7 and 8)
    └── SI-03.15 — depends on SI-03.10, SI-03.12 (reaper/reconciler)

SI-03.17 — depends on SI-03.11, SI-03.14, SI-03.15 (10 GiB end-to-end; Gate 3)
```

Verification Gates → SIs: Gate 1 → SI-03.1 · Gate 2 → SI-03.3 · Gate 3 → SI-03.17 · Gate 4 → SI-03.10 · Gate 5 → SI-03.10 · Gate 6 → SI-03.13 · Gate 7 → SI-03.16 · Gate 8 → SI-03.16. Gate 1 must be recorded before SI-03.5 starts; every gate stays PENDING until its SI records PASS.

---

## Deliverables

- [ ] SI-03.1 — Spike: pg-boss × TypeORM (Verification Gate 1)
- [ ] SI-03.2 — Infra: configuração e contrato de ambiente (storage, upload, worker, fila)
- [ ] SI-03.3 — Infra: imagem MinIO fixada e serviço Compose (Verification Gate 2)
- [ ] SI-03.4 — Módulo de storage S3 (dois endpoints, presigner, bucket)
- [ ] SI-03.5 — Módulo de fila pg-boss (API publica, worker consome)
- [ ] SI-03.6 — Entidade Video, migration e identificador público
- [ ] SI-03.7 — Política de acesso e serviço de início de upload
- [ ] SI-03.8 — Endpoints POST /videos e GET /videos/:id
- [ ] SI-03.9 — Endpoints de partes, retomada e cancelamento
- [ ] SI-03.10 — Serviço de conclusão do upload (Verification Gates 4 e 5)
- [ ] SI-03.11 — Endpoint POST /videos/:id/upload/complete
- [ ] SI-03.12 — Infra: entrypoint do worker e serviço Compose `worker`
- [ ] SI-03.13 — Probe de mídia, regra de formato e thumbnail (Verification Gate 6)
- [ ] SI-03.14 — Worker de processamento do vídeo
- [ ] SI-03.15 — Reaper/reconciliador agendado
- [ ] SI-03.16 — URLs de reprodução e download (Verification Gates 7 e 8)
- [ ] SI-03.17 — Verificação ponta a ponta de 10 GiB (Verification Gate 3)

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npx eslint "{src,apps,libs,test}/**/*.ts"`)
