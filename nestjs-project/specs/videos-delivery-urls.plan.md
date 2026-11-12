---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.16
target_file: nestjs-project/test/videos-delivery-urls.e2e-spec.ts
---

# GET /videos/:id/playback-url e GET /videos/:id/download-url Test Plan

## Application Overview

O dono de um vídeo `ready` obtém URLs presignadas no endpoint público do storage: uma para streaming (`PLAYBACK_PRESIGN_TTL_SECONDS`) e outra para download com `Content-Disposition: attachment` (`DOWNLOAD_PRESIGN_TTL_SECONDS`). O tráfego vai direto ao MinIO, que atende `Range`. As respostas usam `Cache-Control: no-store` e nunca contêm credenciais. A emissão tem teto de 60 URLs por vídeo por hora. Os casos de `Range`, expiração e renovação são checados com `fetch` puro contra as URLs emitidas, na infraestrutura Compose real.

## Test Scenarios

### 1. Emissão e uso das URLs

**Setup:** `beforeEach` limpa as tabelas do banco de teste; o bucket de teste não é criado nem esvaziado pelos hooks (per `phase-03-videos/TD-15` e `phase-03-videos/TD-16`, revisões de 2026-11-12): o storage é acessado somente pelas identidades restritas de teste (`S3_TEST_API_*`, `S3_TEST_WORKER_*`, `S3_TEST_DELIVERY_*`), mapeadas no contexto explícito de teste, nunca por root nem pela identidade de manutenção; cada cenário cria seus próprios vídeos e faz as asserções de storage apenas pelas chaves `videos/<uuid>/…` desses vídeos, sem supor bucket vazio; aplicação montada com `Test.createTestingModule({ imports: [AppModule] }).compile()` e os pipes/filters de `main.ts`; um vídeo do dono é preparado como `ready`, com o objeto `videos/<uuid>/original` gravado no bucket de teste a partir de uma fixture válida pela identidade restrita de teste da API (mesmo perfil de produção, que permite `PutObject` em originais — limitação aceita do TD-04) e `original_filename` = `Meu vídeo.mp4`.

#### 1.1. owner-gets-playback-url

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-12T20:34:20Z

**Steps:**
  1. GET /videos/<id>/playback-url com o token do dono
    - expect: status `200` com `{ url, expires_at }` e header `Cache-Control: no-store`
    - expect: `url` contém o host de `S3_PUBLIC_ENDPOINT`
    - expect: o corpo não contém `S3_SECRET_ACCESS_KEY`, tokens administrativos nem qualquer segredo permanente
    - expect: o único identificador de credencial na `url` é o ID da identidade de entrega (`S3_TEST_DELIVERY_ACCESS_KEY_ID` no teste), dentro do parâmetro `X-Amz-Credential` (AWS Signature V4); o ID da identidade da API e o ID root não aparecem na `url` nem no corpo (per `phase-03-videos/TD-04` revisão de 2026-11-12; SI-03.16 R-AC1)

#### 1.2. range-request-served-by-storage

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-12T20:34:20Z

**Steps:**
  1. `fetch` da `url` emitida com `Range: bytes=0-1023`
    - expect: status `206` com `Content-Range: bytes 0-1023/<tamanho>`, `Content-Length: 1024` e `Accept-Ranges: bytes`
  2. `fetch` com um range insatisfazível (`bytes=<tamanho+10>-`)
    - expect: status `416` (sem afirmar `Content-Range`)
  3. `fetch` da URL sem os parâmetros de assinatura
    - expect: status `403`

#### 1.3. expiry-and-renewal

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-12T20:34:20Z

**Steps:**
  1. Com `PLAYBACK_PRESIGN_TTL_SECONDS` de override pequeno, emitir uma URL e ler `bytes=0-1023`
    - expect: status `206`
  2. Esperar passar `expires_at` e ler `bytes=1024-2047` com a mesma URL
    - expect: status `403`
  3. Pedir uma nova URL e ler `bytes=1024-2047`
    - expect: status `206` com `Content-Range: bytes 1024-2047/<tamanho>`

#### 1.4. download-url-forces-attachment

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-12T20:34:20Z

**Steps:**
  1. GET /videos/<id>/download-url com o token do dono
    - expect: status `200` com `{ url, expires_at }` e `Cache-Control: no-store`
    - expect: o `X-Amz-Credential` da `url` traz o ID da identidade de entrega, não o da API nem o root (SI-03.16 R-AC1)
  2. `fetch` da `url`
    - expect: header `Content-Disposition` com `attachment` e o nome sanitizado codificado por RFC 6266 (`filename*=UTF-8''Meu%20v%C3%ADdeo.mp4`)

### 2. Recusas e limites

**Setup:** igual ao grupo 1.

#### 2.1. not-ready-and-not-owner

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-12T20:34:20Z

**Steps:**
  1. Ajustar o vídeo para `processing`; GET /videos/<id>/playback-url e GET /videos/<id>/download-url pelo dono
    - expect: ambos `409` com `error: "VIDEO_NOT_READY"`
  2. Com o vídeo `ready`, as duas rotas com o token de outro usuário
    - expect: ambas `404` com `error: "VIDEO_NOT_FOUND"`

#### 2.2. delivery-url-cap-and-window-reset

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-12T20:34:20Z

**Steps:**
  1. Emitir 60 URLs alternando playback e download para o mesmo vídeo
    - expect: todas `200`
  2. Emitir a 61ª
    - expect: status `429` com `error: "DELIVERY_URL_LIMIT_EXCEEDED"`
  3. Mover `delivery_window_started_at` para mais de uma hora atrás e emitir de novo
    - expect: status `200`
