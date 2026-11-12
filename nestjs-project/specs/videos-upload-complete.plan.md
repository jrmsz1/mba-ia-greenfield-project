---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: nestjs-project/test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:id/upload/complete Test Plan

## Application Overview

O dono conclui o upload enviando o manifesto ordenado `{ part_number, etag }`. O servidor verifica o manifesto contra `ListParts`, faz o claim compare-and-set `uploading → completing`, chama `CompleteMultipartUpload`, estabelece a prova de conclusão (chave exclusiva, `upload_id`, manifesto verificado, tamanho e `upload-binding`) e só então passa a `uploaded` e publica o job de processamento. Desfechos ambíguos mantêm `completing` com `202` e `Retry-After: 60`. O endpoint compartilha com o status de upload o limite de 120 chamadas por hora por vídeo.

## Test Scenarios

### 1. Conclusão

**Setup:** `beforeEach` limpa as tabelas do banco de teste, esvazia `S3_TEST_BUCKET` e reseta `PGBOSS_TEST_SCHEMA` pelos helpers de teste; aplicação montada com `Test.createTestingModule({ imports: [AppModule] }).compile()` e os pipes/filters de `main.ts`; o dono cria um vídeo de 2 partes (`UPLOAD_PART_SIZE_BYTES` com override ≥ 5 MiB) e envia as duas partes por `PUT` às URLs emitidas, guardando os `ETag`s.

#### 1.1. complete-with-correct-manifest

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-12T15:17:57Z

**Steps:**
  1. POST /videos/<id>/upload/complete com `{ "parts": [{ "part_number": 1, "etag": "<e1>" }, { "part_number": 2, "etag": "<e2>" }] }`
    - expect: status `200` com `processing_status: "uploaded"`
    - expect: exatamente um job `video.process` em `PGBOSS_TEST_SCHEMA` com `data` igual a `{ "videoId": "<uuid>" }`
    - expect: o objeto `videos/<uuid>/original` existe com o tamanho declarado e o metadado `upload-binding` do vídeo

#### 1.2. repeated-complete-is-idempotent

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-12T15:17:57Z

**Steps:**
  1. Depois de 1.1, repetir a mesma requisição
    - expect: status `200` com o `processing_status` atual
    - expect: continua existindo um único job `video.process` para o vídeo

#### 1.3. complete-while-completing-returns-202

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-12T15:17:57Z

**Steps:**
  1. Ajustar o vídeo para `completing` (claim em andamento) no banco de teste; POST /videos/<id>/upload/complete com o manifesto correto
    - expect: status `202` com `processing_status: "completing"` e header `Retry-After: 60`

#### 1.4. invalid-and-mismatched-manifests

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-12T15:17:57Z

**Steps:**
  1. POST com as partes fora de ordem (`[2, 1]`)
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  2. POST com o `etag` da parte 2 trocado
    - expect: status `409` com `error: "UPLOAD_PARTS_MISMATCH"` e `message` citando a parte 2
    - expect: o vídeo continua `uploading`
  3. Reenviar a parte 2 com outro conteúdo por `PUT` e concluir com o `etag` antigo
    - expect: status `409` com `error: "UPLOAD_PARTS_MISMATCH"`

#### 1.5. other-user-gets-404

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-12T15:17:57Z

**Steps:**
  1. POST /videos/<id>/upload/complete com o token de outro usuário e o manifesto correto
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: o vídeo continua `uploading`

### 2. Resultado ambíguo

**Setup:** igual ao grupo 1, com `StorageService` sobrescrito via `overrideProvider` por um dublê que delega ao MinIO real e injeta, em `CompleteMultipartUpload`, timeout com o objeto já concluído, ou resposta `200` com `<Error>` no corpo.

#### 2.1. lost-complete-response-stays-completing

**Covers AC:** #3, #1
**Source:** auto
**Last sync:** 2026-11-12T15:17:57Z

**Steps:**
  1. Injetar timeout depois que o storage concluiu o objeto; POST com o manifesto correto
    - expect: status `202` com `Retry-After`; `processing_status` no banco = `completing`
    - expect: nenhum job `video.process` ainda
  2. Remover a injeção; repetir o POST
    - expect: status `200` com `processing_status: "uploaded"` e um único job

#### 2.2. embedded-error-in-200-is-not-success

**Covers AC:** #3, #4
**Source:** auto
**Last sync:** 2026-11-12T15:17:57Z

**Steps:**
  1. Injetar `200` com `<Error><Code>InternalError</Code></Error>`; POST com o manifesto correto
    - expect: status `202`; `processing_status` = `completing`
  2. Em outro vídeo, injetar `200` com `<Error><Code>InvalidPart</Code></Error>`
    - expect: status `409` com `error: "UPLOAD_PARTS_MISMATCH"`; `processing_status` volta a `uploading`

### 3. Limite de chamadas de controle

**Setup:** igual ao grupo 1; o relógio da janela de controle é avançado manipulando `control_window_started_at` no banco de teste.

#### 3.1. complete-blocked-after-shared-limit

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-12T15:17:57Z

**Steps:**
  1. Fazer 120 chamadas GET /videos/<id>/upload
    - expect: todas `200`
  2. POST /videos/<id>/upload/complete com o manifesto correto
    - expect: status `429` com `error: "UPLOAD_CONTROL_RATE_EXCEEDED"`
    - expect: o `StorageService` (espionado) não recebeu nenhuma chamada nessa requisição
    - expect: nenhuma resposta das rotas de vídeo vem do throttler de autenticação

#### 3.2. legit-upload-completes-after-window-resets

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-12T15:17:57Z

**Steps:**
  1. Esgotar o limite como em 3.1
    - expect: `429`; `processing_status` continua `uploading` e o vídeo continua contando na cota
  2. Mover `control_window_started_at` para mais de uma hora atrás; POST /videos/<id>/upload/complete com o manifesto correto
    - expect: status `200` com `processing_status: "uploaded"`

#### 3.3. client-following-retry-after-stays-under-limit

**Covers AC:** #3, #6
**Source:** auto
**Last sync:** 2026-11-12T15:17:57Z

**Steps:**
  1. Com o vídeo mantido em `completing` pela injeção do grupo 2, repetir o POST 60 vezes (o ritmo de `Retry-After: 60` ao longo de uma hora)
    - expect: todas `202`, nenhuma `429`
  2. Remover a injeção e repetir o POST
    - expect: status `200` com `processing_status: "uploaded"`; nenhuma reserva liberada durante o polling
