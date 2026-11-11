# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm run test:unit                        # Unit tests only (no database)
npm run test:integration                 # Integration tests only (test database)
npm test                                 # Unit + integration tests
npm run test:watch                       # Unit + integration tests in watch mode
npm run test:cov                         # Coverage report (unit + integration)
npm run test:e2e                         # End-to-end tests (test database)
npm run test:db:prepare                  # Create/reset/migrate the test database without running tests

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix (modifies files)
npx eslint "{src,apps,libs,test}/**/*.ts" # ESLint check only (no --fix)
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test database

Integration and e2e tests run **only** against the dedicated test database named by `DB_TEST_NAME` (e.g. `streamtube_test`), never against the development database (`DB_NAME=streamtube`). See `README.md` → "Run tests" for the full setup.

- Both `DB_TEST_NAME` (must match `^[a-z][a-z0-9_]*_test$`) and `DB_TEST_SERVER_ID` (the server's `system_identifier`) must be set in the local `.env`. Without them, integration and e2e runs refuse to start. Get the identifier with `docker compose exec db psql -U streamtube -d streamtube -tAc "SELECT system_identifier FROM pg_control_system()"`.
- The **real value** of `DB_TEST_SERVER_ID` is machine-specific. It must never be included in `.env.example`, test fixtures or any commit; it lives only in the local, git-ignored `.env`. `.env.example` must keep documenting the variable **name with an empty value** (`DB_TEST_SERVER_ID=`). Fixtures use a fictitious identifier.
- Configuring these variables is a one-time step per developer. The test schema is not persistent: it is recreated on every run (see below).
- Keep `DB_NAME` pointing at the development database. `readTestDatabaseConfig()` rejects an original `DB_NAME` equal to `DB_TEST_NAME` (or any other `*_test` name) before any connection. `applyTestDatabaseEnv()` keeps the original value in module-private state (not in any environment variable, so it cannot be forged) before rewriting `DB_NAME`. Repeated calls therefore stay idempotent and never treat the rewritten value as the developer's.
- Every connection is verified (`current_database()` + `system_identifier`) before any schema change. Do not add fallbacks to `DB_NAME`, and do not bypass the guards in `src/test/test-database.ts`.
- **Destructive by design:** every integration/e2e run (via Jest `globalSetup`) and `npm run test:db:prepare` drop all tables, ENUM types and migration history of `DB_TEST_NAME`, then re-apply all migrations. The migrations suite also empties the schema before each test. Never point `DB_TEST_NAME` at data you want to keep.
- New database-backed test files must use the helpers in `src/test/create-test-data-source.ts` (`createTestDataSource`, `createTestTypeOrmModule`, `cleanAllTables`, `resetTestSchema`), which enforce the guard.
- New migrations must be added to `TEST_MIGRATIONS` in `src/test/test-migrations.ts`; the run fails fast if the list is out of sync with `src/database/migrations/`.

### Test execution

Integration and e2e suites share a single test database, so they **must** run serially. Both Jest configs enforce it with `"maxWorkers": 1` (`package.json` → `jest`, and `test/jest-e2e.json`), so the npm scripts are already serialized:

```bash
docker compose exec nestjs-api npm test
docker compose exec nestjs-api npm run test:e2e
```

**Never pass `-w` / `--maxWorkers`** to a run that includes integration or e2e tests. The CLI flag overrides the config, and the guards cannot detect it. Parallel execution causes hook timeouts, FK violations, deadlocks and cross-suite contamination, because suites truncate, seed or reset shared tables concurrently. A separate concurrent Jest process is rejected by an advisory lock on `DB_TEST_NAME`. That lock does not protect against parallel workers inside one run.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). `--selectProjects` takes several values, so pass paths through `--testPathPatterns` when combining them (`npx jest --selectProjects integration --testPathPatterns src/auth`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

### Lint baseline (pending)

`npx eslint "{src,apps,libs,test}/**/*.ts"` currently reports **149 pre-existing errors**. They are a registered blocker for the final Definition of Done and must be fixed in a dedicated task before Phase 03 ends. Until then, a change passes lint only if it adds **no new** lint problems. Check with `npx eslint` (no `--fix`), because `npm run lint` rewrites files.

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config", ...]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `projects` in `package.json` split the suffixes: `unit` (`testRegex: '.*\\.spec\\.ts$'`, setup file `src/test/setup-unit-env.ts` blocks DB access) and `integration` (`testRegex: '.*\\.integration-spec\\.ts$'`, `globalSetup`/`globalTeardown` prepare and lock the test database, setup file `src/test/setup-test-env.ts` points `DB_NAME` at `DB_TEST_NAME`). `test/jest-e2e.json` uses the same globalSetup/globalTeardown and setup file.
- `maxWorkers: 1` at the **root** of both configs. Jest ignores `maxWorkers` inside a `projects` entry, so it cannot be scoped to the integration project.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
