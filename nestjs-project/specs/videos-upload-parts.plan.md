---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: nestjs-project/test/videos-upload-parts.e2e-spec.ts
---

# Upload em andamento — part URLs, retomada e cancelamento Test Plan

## Application Overview

Durante um upload, o dono pede URLs presignadas de `UploadPart` em lotes (`POST /videos/:id/upload/part-urls`), consulta o que o storage já recebeu para retomar (`GET /videos/:id/upload`) e pode cancelar um upload incompleto (`DELETE /videos/:id/upload`). A emissão de URLs tem teto por upload; status e conclusão compartilham um limite de 120 chamadas por hora por vídeo; o cancelamento só libera a cota com abort comprovado.

## Test Scenarios

### 1. URLs de parte

**Setup:** `beforeEach` limpa as tabelas do banco de teste e esvazia `S3_TEST_BUCKET`; aplicação montada com `Test.createTestingModule({ imports: [AppModule] }).compile()` e os pipes/filters de `main.ts`; o dono faz login e cria um vídeo por POST /videos com `size_bytes` igual a 3 partes de `UPLOAD_PART_SIZE_BYTES` (override pequeno, ≥ 5 MiB).

#### 1.1. issue-part-urls-batch

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. POST /videos/<id>/upload/part-urls com `{ "part_numbers": [1, 2] }`
    - expect: status `200` com `parts` de 2 entradas `{ part_number, url, expires_at }`
    - expect: cada `expires_at` cerca de `UPLOAD_PART_PRESIGN_TTL_SECONDS` à frente do momento da requisição
    - expect: header `Cache-Control: no-store`
    - expect: cada `url` contém o host de `S3_PUBLIC_ENDPOINT`

#### 1.2. invalid-part-numbers-rejected

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. POST /videos/<id>/upload/part-urls com `{ "part_numbers": [4] }` (fora de `1..expected_part_count`)
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  2. POST /videos/<id>/upload/part-urls com `{ "part_numbers": [1, 1] }`
    - expect: status `400` com `error: "VALIDATION_ERROR"`

#### 1.3. part-urls-after-expiry

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. Ajustar `upload_expires_at` do vídeo para o passado no banco de teste; POST /videos/<id>/upload/part-urls com `{ "part_numbers": [1] }`
    - expect: status `409` com `error: "UPLOAD_EXPIRED"`

#### 1.4. part-url-issuance-cap

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. Para um vídeo de 2 partes, pedir URLs em lotes que somam 20 URLs
    - expect: todos `200`
  2. Pedir mais uma URL
    - expect: status `429` com `error: "PART_URL_LIMIT_EXCEEDED"`
  3. Em outro vídeo de 2 partes, disparar 25 pedidos simultâneos de 1 URL
    - expect: no máximo 20 respostas `200`; `part_urls_issued` no banco nunca passa de 20

### 2. Retomada

**Setup:** igual ao grupo 1.

#### 2.1. resume-lists-received-and-missing-parts

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. Pedir URLs das partes 1 e 3 e enviar `PUT` com o conteúdo de cada parte diretamente às URLs (fetch puro)
    - expect: cada `PUT` responde `200` com header `ETag`
  2. GET /videos/<id>/upload
    - expect: status `200` com `parts` contendo os números 1 e 3, cada um com `size_bytes` e `etag` iguais aos enviados
    - expect: `missing_part_numbers: [2]`

#### 2.2. control-rate-limit-on-status

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. Fazer 120 chamadas GET /videos/<id>/upload na mesma janela
    - expect: todas `200`
  2. Fazer a 121ª chamada
    - expect: status `429` com `error: "UPLOAD_CONTROL_RATE_EXCEEDED"`
    - expect: o `StorageService` (espionado) não recebeu `ListParts` nessa chamada

#### 2.3. control-rate-limit-is-shared-with-complete

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. Fazer 100 chamadas GET /videos/<id>/upload e 20 chamadas POST /videos/<id>/upload/complete com manifesto incompleto
    - expect: as GET respondem `200` e os complete respondem `409` `UPLOAD_PARTS_MISMATCH`
  2. Fazer mais uma GET /videos/<id>/upload
    - expect: status `429` com `error: "UPLOAD_CONTROL_RATE_EXCEEDED"`

### 3. Cancelamento

**Setup:** igual ao grupo 1; para os cenários de falha, `StorageService` sobrescrito via `overrideProvider` por um dublê que delega ao MinIO real e injeta erro ou indisponibilidade em `AbortMultipartUpload`/`ListParts`/`HeadObject`.

#### 3.1. abort-cancels-and-invalidates-part-urls

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. Pedir a URL da parte 2; DELETE /videos/<id>/upload
    - expect: status `204`
    - expect: `processing_status` no banco = `cancelled`
  2. Enviar `PUT` na URL da parte 2 emitida antes
    - expect: o storage rejeita o envio (sem `200`)
  3. Repetir DELETE /videos/<id>/upload
    - expect: status `204` sem efeito adicional

#### 3.2. abort-rejected-while-completing

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. Ajustar o vídeo para `completing` no banco de teste; DELETE /videos/<id>/upload
    - expect: status `409` com `error: "INVALID_VIDEO_STATE"`

#### 3.3. abort-with-storage-down-keeps-reservation

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. Injetar storage inacessível; DELETE /videos/<id>/upload
    - expect: status `503` com `error: "STORAGE_UNAVAILABLE"`
    - expect: `processing_status` continua `uploading`, e o vídeo continua contando na cota (`MAX_ACTIVE_UPLOADS_PER_OWNER=1` faz um novo start falhar com `ACTIVE_UPLOAD_LIMIT_EXCEEDED`)

#### 3.4. abort-repeated-until-confirmed

**Covers AC:** #6, #7
**Source:** auto
**Last sync:** 2026-11-12T01:29:06Z

**Steps:**
  1. Injetar um primeiro `AbortMultipartUpload` com erro transitório seguido de sucesso; DELETE /videos/<id>/upload
    - expect: status `204` e `processing_status = cancelled` somente depois que `ListParts` responde `NoSuchUpload` e `HeadObject` responde `404`
  2. Injetar `ListParts` que nunca confirma `NoSuchUpload` (resultado `indeterminate`); DELETE em outro vídeo
    - expect: status `503` com `error: "STORAGE_UNAVAILABLE"`; nenhuma transição para `cancelled`; a reserva continua contando na cota
