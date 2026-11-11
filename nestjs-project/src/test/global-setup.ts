// Configured only on Jest projects that need a real database (integration,
// e2e). Jest triggers a project's globalSetup only when at least one test of
// that project is selected, so unit-only runs never reach PostgreSQL.
//
// globalSetup runs once, in the parent process, BEFORE and independently of
// `setupFiles` — so it must load `.env` itself rather than rely on the
// `dotenv/config` setup file. `prepare-test-database` imports `dotenv/config`.
import { prepareTestDatabase, type TestRunLock } from './prepare-test-database';

declare global {
  var __STREAMTUBE_TEST_RUN_LOCK__: TestRunLock | undefined;
}

export default async function globalSetup(): Promise<void> {
  // Held until globalTeardown so a concurrent run cannot reset the database.
  globalThis.__STREAMTUBE_TEST_RUN_LOCK__ = await prepareTestDatabase();
}
