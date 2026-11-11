---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-10T20:13:08-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-11T18:13:20-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-10T20:13:08-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-10T20:13:08-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-10T20:13:08-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-10T20:13:08-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-10T20:13:08-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos
**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._
**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.
**Affected subprojects:** No subprojects explicitly mentioned in the phase block (depends on Fase 01, Fase 02). The phase decisions doc scopes implementation to `nestjs-project/` only; `next-frontend/` has no decision or implementation in this phase.
**Deferred subprojects:** _None._
**Sequencing notes:** _None._ (Only the dependency line "Depende de: Fase 01, Fase 02".)

**Resolved boundary — Phase 03 × Phase 04 (AMB-1, resolved by `/plan-resolve` on 2026-11-11; recorded here because `project-plan.md` was not edited):**

- Phase 03 creates and processes the video as a **private draft**.
- `processing_status = ready` does **not** imply publication.
- Phase 04 owns the transition to published and the public visibility (and the editing of the video's information).
- Phase 03 keeps the `publication` state (TD-09) and the owner-only access until published (TD-12) so Phase 04 can extend them.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Large-file upload protocol and transport | decided | A (S3 multipart with per-part presigned URLs) | — |
| phase-03-videos/TD-02 | phase | Backend | Upload resumability, completion and cross-system consistency | decided | A (verified client manifest) | — |
| phase-03-videos/TD-03 | phase | Backend | S3-compatible object storage server (MinIO) | decided | A (pinned MinIO from GitHub release asset, SHA-256-verified custom image) | — |
| phase-03-videos/TD-04 | phase | Backend | S3 client library and endpoint/signing model | decided | A (AWS SDK v3, two endpoints) | `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x` |
| phase-03-videos/TD-05 | phase | Backend | Background job queue and job-loss prevention | decided | A (pg-boss) | `pg-boss@^12.x` |
| phase-03-videos/TD-06 | phase | Backend | Media worker topology and responsibilities | decided | A (second entrypoint in nestjs-project) | — |
| phase-03-videos/TD-07 | phase | Backend | FFmpeg/ffprobe toolchain, validity rules and resource limits | decided | A (system ffmpeg/ffprobe via spawn) | — |
| phase-03-videos/TD-08 | phase | Backend | Processing input access and scratch storage | decided | A (HTTP Range over presigned GET) | — |
| phase-03-videos/TD-09 | phase | Backend | Video lifecycle state machine and failure handling | decided | A (orthogonal publication and processing_status) | — |
| phase-03-videos/TD-10 | phase | Backend | Unique public video identifier and storage keys | decided | A (random base62 id with unique index) | — |
| phase-03-videos/TD-11 | phase | Backend | HTTP streaming and download delivery | decided | A (presigned GET, Range directly on storage) | — |
| phase-03-videos/TD-12 | phase | Backend | Authorization, ownership by channel and channel isolation | decided | A (owner-only until published, single policy function) | — |
| phase-03-videos/TD-13 | phase | Backend | Upload validation, abuse controls and untrusted-file handling | decided | A (layered controls) | — |
| phase-03-videos/TD-14 | phase | Backend | Orphan resource cleanup and reconciliation | decided | A (scheduled reaper/reconciler) | — |
| phase-03-videos/TD-15 | phase | Backend | Test strategy for storage, queue, worker and the API contract | decided | A (real services with isolation guards) | — |
| phase-03-videos/TD-16 | phase | Repo-wide | Docker Compose topology and environment contract | decided | A (extend nestjs-project/compose.yaml) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-15, phase-03-videos/TD-16 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-02, phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-14, phase-03-videos/TD-15, phase-03-videos/TD-16 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-01, phase-03-videos/TD-02, phase-03-videos/TD-04, phase-03-videos/TD-13, phase-03-videos/TD-14, phase-03-videos/TD-15 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-01, phase-03-videos/TD-02, phase-03-videos/TD-09, phase-03-videos/TD-12, phase-03-videos/TD-14 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-15 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-15 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-10 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-04, phase-03-videos/TD-11, phase-03-videos/TD-12, phase-03-videos/TD-15 |
| Download do vídeo pelo usuário | phase-03-videos/TD-04, phase-03-videos/TD-11, phase-03-videos/TD-12, phase-03-videos/TD-15 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** it is the only option that keeps the transfer off both Node processes, resumes natively, and is verifiable end to end with HTTP clients; its costs (client logic, endpoint reachability, part-size verification) are bounded and testable.
**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** it keeps the client's recorded manifest as the completion input, verifies it against storage before completing, and uses `HeadObject`, conditional transitions and reconciliation — never a timeout — to resolve the ambiguity of a lost `Complete` response; fall back to Option B only if the selected server's `ListParts` fails validation.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** For the academic/local environment only — it is the only candidate whose behavior was demonstrated for every operation of this phase, it honors the brief's MinIO requirement, and the concrete blocker on the named source (`dl.min.io` 410) has a verified workaround (the GitHub release assets); Option D is not recommended merely because MinIO is unmaintained, and stays the documented fallback if the GitHub assets disappear or a smoke test of the built image fails.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** portability and the demonstrated behavior (including the host-binding trap) outweigh the two-endpoint configuration cost.
**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-05

**Recommendation:** it reuses the PostgreSQL already in the stack, adds no service, and offers the retries, backoff, dead-lettering, heartbeat and scheduling this phase needs at the expected volume; it is conditional on the validation spike listed below, and if transactional enqueue does not work the fallback is a durable, documented and tested outbox/reconciliation on PostgreSQL — Redis is **not** introduced as a silent fallback (BullMQ stays a separately decided alternative).
**Libraries:** `pg-boss@^12.x`

### phase-03-videos/TD-06

**Recommendation:** it meets "worker independente" with the least duplication and leaves the existing layout and test baseline intact.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** two fixed commands do not justify a wrapper, and the deprecated one is a poor foundation; everything the brief asks (duration, metadata, thumbnail, invalid files, limits) was demonstrated with the raw binaries.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** processing reads by HTTP Range, falling back to a local copy (Option C) only if tests demonstrate it is needed; the measured seek behavior removes the need to copy large files for the operations this phase performs.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** it separates the two concerns the brief names and makes duplicate, retried and racing events harmless by construction.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** the only option that is short and non-enumerable without a dependency; the unique index plus a bounded `ON CONFLICT` retry removes the collision risk without the aborted-transaction trap.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** it keeps the transfer off NestJS and Next.js, matches the planned architecture, preserves authorization at URL emission and was demonstrated on the pinned storage; the API proxy stays a documented future alternative (Option B) for when per-request authorization/revocation or strictly RFC-recommended Range responses become necessary.
**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** the secure default for drafts at the cost of one function that Phases 04–05 extend.
**Libraries:** —

### phase-03-videos/TD-13

**Recommendation:** `ffprobe` is the authoritative parser, the state machine already provides the rejection path, and the size/part checks plus quotas close the abuse vectors that matter for this phase.
**Libraries:** —

### phase-03-videos/TD-14

**Recommendation:** it works on the pinned build where Option B does not and also reconciles state; Option C stays an optional hardening for servers that enforce the lifecycle action.
**Libraries:** —

### phase-03-videos/TD-15

**Recommendation:** it keeps the project's testing pyramid and places the real-service checks where the highest risk lives; the guards must refuse any non-test bucket or queue schema before a reset.
**Libraries:** —

### phase-03-videos/TD-16

**Recommendation:** the smallest change that makes storage and worker reproducible, consistent with the existing per-subproject Compose files.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** (`@nestjs/swagger`) — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger
**Revisions:** 2026-05-12 — O CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). Enriquecimento via decoradores explícitos faz parte da Option A escolhida.

### openapi-docs-nestjs/TD-02

**Recommendation:** (Ambos) — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** (Apenas em dev/staging) — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` — Feature Implementation Checklist)_

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit (mock repo) + Integration (DB contract) |
| Service with DB only (no branching) | Integration (DB contract) |
| Service with configured lib (JWT, cache) | Unit with the real lib and test config |
| Service with side-effect dep (email, storage) | Integration with a real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — no unit tests |
| DTO | E2E: one validation-wiring test per endpoint |
| Guard (delegates to service) | E2E + Unit if complex internal logic |
| Guard (simple, Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom) | Unit |
| Interceptor | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

### next-frontend

_No testing requirements — `next-frontend/` has no decision or implementation in this phase._

### Required Technical Verification Gates

_Source: the "Future validations" list of `docs/decisions/technical-decisions-phase-03-videos.md`, carried here so that `plan-build` consumes it. These conditions do not reopen any decision and add no requirement to the phase scope. **All eight are PENDING — none has been executed or approved.**_

_Instruction to `plan-build`: assign each condition below to a Step Implementation, a spike, a test, or an acceptance criterion, and order them respecting their dependencies (for example, the TD-05 proof is the initial condition for planning the queue implementation, and the conditions that need real storage or the Compose infrastructure follow the MinIO build/run condition). The Phase 03 × Phase 04 boundary recorded under `## Scope` still applies: nothing here moves publication or public visibility into Phase 03._

| # | TD refs | Status | Required verification |
|---|---------|--------|-----------------------|
| 1 | phase-03-videos/TD-05 | PENDING | **TypeORM + `pg-boss`:** prove transactional integration — commit, rollback and durable recovery. This proof is the initial condition for planning the queue implementation. |
| 2 | phase-03-videos/TD-03, phase-03-videos/TD-16 | PENDING | **MinIO:** build a reproducible image of the pinned MinIO, verifying the SHA-256 during the build; validate Docker Compose, healthcheck and CORS. Preserve the additionally documented minisign signature check and the ARM64 asset checksum, as applicable. |
| 3 | phase-03-videos/TD-01, phase-03-videos/TD-08, phase-03-videos/TD-13 | PENDING | **10 GiB upload:** demonstrate multipart upload, resumption, completion and processing up to the defined limit. |
| 4 | phase-03-videos/TD-02 | PENDING | **Ambiguous completion:** prove the identity and integrity of the object found after a lost `CompleteMultipartUpload` response; do not rely only on a matching size. |
| 5 | phase-03-videos/TD-02, phase-03-videos/TD-09 | PENDING | **Concurrency:** test two simultaneous completions of the same video, ensuring conditional transitions and no duplicated effects. |
| 6 | phase-03-videos/TD-07, phase-03-videos/TD-15 | PENDING | **Real content:** create fixtures that prove MP4 container identification, H.264 video and optional AAC audio, without trusting the file extension alone. |
| 7 | phase-03-videos/TD-11 | PENDING | **Presigned URLs:** test expiry and renewal during prolonged playback. |
| 8 | phase-03-videos/TD-11 | PENDING | **Streaming:** prove HTTP Range directly on MinIO, using URLs emitted by the API and the real Compose infrastructure. |
