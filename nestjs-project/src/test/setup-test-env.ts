// Runs per test file (setupFiles), after `dotenv/config`. Rewrites DB_NAME to
// the validated test database so anything that boots AppModule (e2e,
// openapi export) connects to it. Throws if the test target is not configured.
import { applyTestDatabaseEnv } from './test-database';
import { applyTestQueueEnv } from './test-queue';
import { applyTestStorageEnv } from './test-storage';

applyTestDatabaseEnv();
// Same for the pg-boss schema: PGBOSS_SCHEMA -> PGBOSS_TEST_SCHEMA.
applyTestQueueEnv();
// And for object storage: S3_BUCKET -> S3_TEST_BUCKET.
applyTestStorageEnv();
