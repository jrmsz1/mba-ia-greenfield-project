<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

All commands run **inside the container** (`docker compose exec nestjs-api ...`), with the infrastructure up (`docker compose up -d`).

| Command | What runs | Touches a database |
|---|---|---|
| `npm run test:unit` | `*.spec.ts` (Jest project `unit`) | No — `DB_HOST` is forced to an unresolvable `.invalid` host |
| `npm run test:integration` | `*.integration-spec.ts` (Jest project `integration`) | Yes — `DB_TEST_NAME` only |
| `npm test` | Both projects above | Yes — `DB_TEST_NAME` only |
| `npm run test:e2e` | `test/*.e2e-spec.ts` | Yes — `DB_TEST_NAME` only |
| `npm run test:cov` | Both Jest projects with coverage | Yes — `DB_TEST_NAME` only |
| `npm run test:db:prepare` | Creates (if missing), resets and migrates the test database, without running tests | Yes — `DB_TEST_NAME` only |

```bash
docker compose exec nestjs-api npm run test:unit
docker compose exec nestjs-api npm run test:integration
docker compose exec nestjs-api npm run test:e2e
```

### Test database setup (once per developer)

Integration and e2e tests never use the development database (`DB_NAME=streamtube`). They run against a dedicated database whose target must be declared explicitly in your local `.env` (see `.env.example`). This configuration is done once per developer and machine. The test **schema** is not kept: it is recreated on every run (see below).

```dotenv
DB_TEST_NAME=streamtube_test
DB_TEST_SERVER_ID=<system_identifier of your PostgreSQL server>
```

Get the server identifier with:

```bash
docker compose exec db psql -U streamtube -d streamtube -tAc "SELECT system_identifier FROM pg_control_system()"
```

- `DB_TEST_NAME` must match `^[a-z][a-z0-9_]*_test$`. Keep `DB_NAME` pointing at your development database (`streamtube`). The guard rejects a configuration where the original `DB_NAME` is equal to `DB_TEST_NAME`, or is another `*_test` database. This check runs in the Jest `globalSetup` (integration and e2e), in `npm run test:db:prepare` and in every test file, before any connection is opened.
- `DB_TEST_SERVER_ID` pins the PostgreSQL server allowed to host the test database. Its real value is specific to your local server: put it in `.env` only, never in `.env.example` or in a commit. `.env.example` keeps the variable name with an empty value.
- Without both variables, integration and e2e runs refuse to start. Unit tests do not need them.
- The database itself is created automatically on the first run. No manual `CREATE DATABASE` is needed. After that, every integration/e2e run and every `npm run test:db:prepare` drops and recreates its schema.

Before changing anything, every run checks the target: the variables are validated, then `current_database()` and the server `system_identifier` are verified on the live connection. Any mismatch aborts the run; there is no fallback to `DB_NAME`.

### ⚠️ The test database is destroyed on every run

Each integration or e2e run (and `npm run test:db:prepare`) **drops every table, ENUM type and the migration history of `DB_TEST_NAME`**, then re-applies all migrations. The migrations suite also empties the schema before each of its tests. Never point `DB_TEST_NAME` at a database whose data you want to keep.

### Suites run serially — do not override it

Integration and e2e suites share the single test database, so they must never run in parallel. Parallel workers cause hook timeouts, FK violations and cross-suite contamination; the migrations suite resets the schema while other suites are using it.

- Both Jest configs set `"maxWorkers": 1` (`package.json` → `jest`, and `test/jest-e2e.json`), so every command above already runs serially.
- **Do not pass `-w` / `--maxWorkers`** to runs that include integration or e2e tests. A CLI `-w N` overrides the config, and the guards cannot detect it.
- A second, concurrent Jest process is rejected by an advisory lock on `DB_TEST_NAME` ("Another test run is using ..."). The lock protects against separate runs, not against parallel workers inside one run.
- Jest's `--selectProjects` takes several values. Put file paths in `--testPathPatterns` instead of right after it: `npx jest --selectProjects integration --testPathPatterns src/auth`.

### Known pending issues (technical debt)

- **Lint warning:** `npx eslint "{src,apps,libs,test}/**/*.ts"` reports 0 errors and 1 known warning: `@typescript-eslint/no-unsafe-argument` in `src/auth/auth.service.integration-spec.ts` (line 479). The original baseline had 149 errors (and 40 warnings), fixed in five dedicated commits without disabling rules or weakening the TypeScript settings. `npm run lint` passes with exit code 0, but it runs ESLint with `--fix` and rewrites files. To check without changing anything, run `npx eslint` directly.
- **CHANNEL-NICKNAME-RACE — nickname retry runs in an aborted PostgreSQL transaction (production defect, not fixed yet):**
  - **Trigger:** two sign-ups race for the same nickname. The pre-check in `ChannelsService.createChannel()` misses the collision and the `INSERT` fails with `23505` on `nickname`.
  - **Defect:** the service detects the violation correctly and retries with a suffixed nickname, but inside the same `dataSource.transaction`, which PostgreSQL has already aborted. The first statement of the retry fails with `25P02` (`current transaction is aborted, commands ignored until end of transaction block`), so `createChannel()` rejects with that error instead of assigning an alternative nickname. The sign-up fails (`UsersService.createUserWithChannel` compensates by deleting the user it had just created).
  - **Evidence:** reproduced against a real PostgreSQL by forcing the pre-check to miss.
  - **Why the tests miss it:** the unit tests mock the transaction manager, and the integration tests only cover a sequential collision, which the pre-check resolves. No test covers the real concurrent collision.
  - **Pending:** a functional fix, independent of the lint work, together with an integration test against a real database that reproduces the concurrency. `.claude/rules/typeorm-queries.md` describes the savepoint-per-attempt pattern for retry-on-collision. `isPgUniqueViolationOnColumn()` is correct and was not changed.
- **L1 — `auth.service.integration-spec.ts`:** when a `beforeAll` fails, the `afterAll` calls `dataSource.destroy()` on `undefined` and adds a secondary `TypeError`. The original error is still reported.
- **L2 — `auth.service.integration-spec.ts`:** when `Test.createTestingModule().compile()` fails after TypeORM has connected, that connection is never closed. Jest prints "did not exit one second after the test run" and the process lingers about 10 s, until pg's idle timeout. This happens only on an already-failing run.
- **OpenAPI export test:** the `beforeAll` of `src/openapi-export.integration-spec.ts` takes about 3.8 s in a serial run, roughly 76 % of Jest's default 5 s hook timeout. It is the hook most at risk of a timeout.

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
