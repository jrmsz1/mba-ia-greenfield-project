// Configured only on Jest projects that need a real database (integration,
// e2e). Jest triggers a project's globalSetup only when at least one test of
// that project is selected, so unit-only runs never reach PostgreSQL.
//
// globalSetup runs once, in the parent process, BEFORE and independently of
// `setupFiles` — so it must load `.env` itself rather than rely on the
// `dotenv/config` setup file. `prepare-test-database` imports `dotenv/config`.
import { prepareTestDatabase, type TestRunLock } from './prepare-test-database';
import { readTestStorageTarget } from './test-storage';

declare global {
  var __STREAMTUBE_TEST_RUN_LOCK__: TestRunLock | undefined;
}

export default async function globalSetup(): Promise<void> {
  // Storage is only verified, never reset, by the suites (phase-03-videos/
  // TD-15 revisions of 2026-11-12): fail closed before any reset when the
  // test bucket or the restricted test identities are not a valid target, or
  // when maintenance credentials reached this process.
  readTestStorageTarget(process.env);
  // Held until globalTeardown so a concurrent run cannot reset the database.
  globalThis.__STREAMTUBE_TEST_RUN_LOCK__ = await prepareTestDatabase();
}
