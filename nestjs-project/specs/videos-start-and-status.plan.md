---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: nestjs-project/test/videos-start-and-status.e2e-spec.ts
---

# POST /videos e GET /videos/:id Test Plan

## Application Overview

`POST /videos` inicia o upload de um vídeo: cria o rascunho privado (`publication: draft`) e o multipart S3, de forma idempotente por `Idempotency-Key`, com reserva atômica de cota por proprietário. `GET /videos/:id` devolve o status do rascunho somente ao dono. As duas rotas exigem autenticação, ficam fora do throttler de autenticação (`@SkipThrottle()`) e respondem erros no envelope `{ statusCode, error, message }`.

## Test Scenarios

### 1. Início do upload

**Setup:** `beforeEach` limpa as tabelas do banco de teste (`cleanAllTables`) e esvazia `S3_TEST_BUCKET` pelo helper de teste; a aplicação é montada com `Test.createTestingModule({ imports: [AppModule] }).compile()` e os mesmos pipes/filters de `main.ts`; dois usuários confirmados (dono e outro) obtêm access tokens via `POST /auth/login`.

#### 1.1. start-creates-private-draft

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <dono>`, `Idempotency-Key: k-1` e `{ "filename": "clip.mp4", "size_bytes": 10485760 }`
    - expect: status `201`
    - expect: corpo com `id` (11 caracteres base62), `upload_id`, `part_size_bytes`, `expected_part_count`, `upload_expires_at` (ISO-8601 no futuro), `processing_status: "uploading"` e `publication: "draft"`
    - expect: uma linha em `videos` com `upload_id` preenchido e um multipart aberto em `videos/<uuid>/original`

#### 1.2. start-retry-is-idempotent

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. POST /videos com `Idempotency-Key: k-2` e um payload válido
    - expect: status `201`
  2. Repetir exatamente a mesma requisição
    - expect: status `200` com o mesmo `id` e o mesmo `upload_id`
    - expect: uma única linha em `videos` e um único multipart aberto na chave do vídeo
  3. Repetir com a mesma chave e `size_bytes` diferente
    - expect: status `409` com `error: "IDEMPOTENCY_KEY_CONFLICT"`

#### 1.3. start-validation-and-size-limit

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. POST /videos sem o header `Idempotency-Key`
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  2. POST /videos com `size_bytes` = `MAX_UPLOAD_BYTES + 1` (override pequeno de `MAX_UPLOAD_BYTES` no ambiente de teste)
    - expect: status `400` com `error: "UPLOAD_SIZE_EXCEEDED"`
    - expect: nenhuma linha criada em `videos`

#### 1.4. start-is-not-throttled-by-auth-limit

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. Enviar 12 requisições POST /videos em menos de um minuto, do mesmo cliente, com chaves diferentes (cotas configuradas amplas)
    - expect: nenhuma resposta `429` vinda do throttler de autenticação
    - expect: nenhuma resposta `429` com `error` ausente ou diferente dos códigos de domínio

#### 1.5. start-without-token-is-rejected

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. POST /videos sem `Authorization`
    - expect: status `401`
  2. GET /videos/<id-existente> sem `Authorization`
    - expect: status `401`

### 2. Falhas e recuperação de CreateMultipartUpload

**Setup:** igual ao grupo 1, com `StorageService` sobrescrito via `overrideProvider` por um dublê que delega ao MinIO real e injeta a falha pedida em `CreateMultipartUpload` (rejeição definitiva, timeout, ou criação concluída com resposta perdida).

#### 2.1. definitive-create-failure-deletes-reservation

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. Injetar rejeição definitiva em `CreateMultipartUpload`; POST /videos com payload válido
    - expect: status `503` com `error: "STORAGE_UNAVAILABLE"` e header `Retry-After`
    - expect: nenhuma linha em `videos` para a chave usada
  2. Remover a injeção; POST /videos com outra chave
    - expect: status `201` (a cota não ficou consumida)

#### 2.2. ambiguous-create-keeps-reservation-and-retry-recovers

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. Injetar criação concluída no storage com resposta perdida; POST /videos com `Idempotency-Key: k-lost`
    - expect: status `503` com `error: "STORAGE_UNAVAILABLE"`
    - expect: a linha do vídeo existe com `upload_id = NULL` e `multipart_create_attempted_at` preenchido, e continua contando na cota (`MAX_ACTIVE_UPLOADS_PER_OWNER=1` faz um start com outra chave falhar com `ACTIVE_UPLOAD_LIMIT_EXCEEDED`)
  2. Remover a injeção; repetir POST /videos com `Idempotency-Key: k-lost`
    - expect: status `200` com `upload_id` preenchido
    - expect: um único multipart aberto na chave do vídeo (a sessão órfã foi abortada)

#### 2.3. concurrent-retries-create-one-session

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. Deixar uma reserva com `upload_id = NULL` (como em 2.2); disparar 3 POST /videos simultâneos com a mesma `Idempotency-Key`
    - expect: exatamente um multipart aberto na chave do vídeo
    - expect: as requisições que não obtêm o lock recebem `409` com `error: "UPLOAD_START_IN_PROGRESS"` imediatamente, com `Retry-After`

#### 2.4. indeterminate-investigation-keeps-reservation

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. Deixar uma reserva com `upload_id = NULL`; injetar storage inacessível em `ListMultipartUploads`/`HeadObject`; repetir POST /videos com a mesma chave
    - expect: status `503` com `error: "STORAGE_UNAVAILABLE"`
    - expect: a reserva continua existindo, com `upload_id = NULL`, e nenhum multipart novo foi criado

### 3. Status do rascunho

**Setup:** igual ao grupo 1; o dono cria um vídeo por POST /videos.

#### 3.1. owner-reads-draft-others-get-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. GET /videos/<id> com o token do dono
    - expect: status `200` com `publication: "draft"`, `processing_status: "uploading"`, `has_thumbnail: false`
    - expect: o corpo não contém `upload_id` nem `upload_binding_token`
  2. GET /videos/<id> com o token do outro usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  3. GET /videos/not-a-valid-id com o token do dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
