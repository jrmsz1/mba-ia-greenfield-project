/**
 * External test-storage maintenance (phase-03-videos/TD-15, TD-16 revisions
 * of 2026-11-12): fixture removal and cleanup of S3_TEST_BUCKET.
 *
 * Runs ONLY in an ephemeral, on-demand container (never a Compose service,
 * never inside `nestjs-api` or `worker`), with the S3_TEST_MAINTENANCE_*
 * identity, whose policy covers S3_TEST_BUCKET only. Test suites never call
 * it. It never touches another bucket and never creates or deletes buckets.
 *
 * Fail-closed order: static guards (explicit maintenance context, target is
 * S3_TEST_BUCKET, ends with -test, differs from S3_BUCKET, no operational or
 * root credential in this process) → the test-run advisory lock (the same one
 * Jest's globalSetup holds, so it never runs concurrently with a suite) →
 * HeadBucket → abort multipart sessions → delete objects. Dry run by default;
 * `--confirm` is required to remove anything. Prints counts, never secrets.
 */
import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Client } from 'pg';
import { TEST_RESOURCE_PATTERNS } from '../config/video.constants';
import { TEST_MAINTENANCE_KEYS } from './test-storage';

export class StorageMaintenanceGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageMaintenanceGuardError';
  }
}

/** Explicit marker: this process is the maintenance container. */
export const MAINTENANCE_CONTEXT_KEY = 'STREAMTUBE_TEST_MAINTENANCE';

/** Credentials that must never be present in the maintenance process. */
const FORBIDDEN_KEYS = [
  'MINIO_ROOT_USER',
  'MINIO_ROOT_PASSWORD',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_DELIVERY_ACCESS_KEY_ID',
  'S3_DELIVERY_SECRET_ACCESS_KEY',
] as const;

/** Same database and key as the test-run lock (prepare-test-database.ts). */
const LOCK_DATABASE = 'postgres';

export interface MaintenancePlan {
  bucket: string;
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  database: {
    host: string;
    port: number;
    user: string;
    password: string;
    testDatabase: string;
    serverId: string;
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new StorageMaintenanceGuardError(
      `${key} is required for test-storage maintenance.`,
    );
  }
  return value;
}

/** Static, network-free guards; throws before anything is contacted. */
export function readMaintenancePlan(
  env: NodeJS.ProcessEnv = process.env,
): MaintenancePlan {
  if (env[MAINTENANCE_CONTEXT_KEY] !== '1') {
    throw new StorageMaintenanceGuardError(
      `${MAINTENANCE_CONTEXT_KEY}=1 is required: maintenance runs only in the explicit maintenance context.`,
    );
  }
  const present = FORBIDDEN_KEYS.filter((key) => env[key] !== undefined);
  if (present.length > 0) {
    throw new StorageMaintenanceGuardError(
      `${present.join(', ')} must not be set: maintenance never runs with root or operational credentials (not inside nestjs-api/worker).`,
    );
  }
  const bucket = required(env, 'S3_TEST_BUCKET');
  if (!TEST_RESOURCE_PATTERNS.S3_BUCKET.test(bucket)) {
    throw new StorageMaintenanceGuardError(
      `Refusing bucket "${bucket}": the target must match ${TEST_RESOURCE_PATTERNS.S3_BUCKET.source}.`,
    );
  }
  const operational = required(env, 'S3_BUCKET');
  if (operational === bucket) {
    throw new StorageMaintenanceGuardError(
      `S3_BUCKET and S3_TEST_BUCKET are both "${bucket}": refusing an ambiguous target.`,
    );
  }
  const testDatabase = required(env, 'DB_TEST_NAME');
  if (!/^[a-z][a-z0-9_]*_test$/.test(testDatabase)) {
    throw new StorageMaintenanceGuardError(
      `DB_TEST_NAME "${testDatabase}" is not a test database name.`,
    );
  }
  return {
    bucket,
    endpoint: required(env, 'S3_ENDPOINT'),
    region: env.S3_REGION?.trim() || 'us-east-1',
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
    accessKeyId: required(env, TEST_MAINTENANCE_KEYS[0]),
    secretAccessKey: required(env, TEST_MAINTENANCE_KEYS[1]),
    database: {
      host: required(env, 'DB_HOST'),
      port: Number(env.DB_PORT ?? '5432'),
      user: required(env, 'DB_USERNAME'),
      password: required(env, 'DB_PASSWORD'),
      testDatabase,
      serverId: required(env, 'DB_TEST_SERVER_ID'),
    },
  };
}

export interface MaintenanceReport {
  bucket: string;
  confirmed: boolean;
  multipartSessions: number;
  objects: number;
}

/**
 * Holds the test-run advisory lock for the duration of `work`: a running
 * suite (or another maintenance run) makes this fail instead of racing it.
 */
async function withTestRunLock<T>(
  plan: MaintenancePlan,
  work: () => Promise<T>,
): Promise<T> {
  const client = new Client({
    host: plan.database.host,
    port: plan.database.port,
    user: plan.database.user,
    password: plan.database.password,
    database: LOCK_DATABASE,
  });
  await client.connect();
  try {
    const identity = await client.query<{ id: string }>(
      'SELECT system_identifier::text AS id FROM pg_control_system()',
    );
    if (identity.rows[0]?.id !== plan.database.serverId) {
      throw new StorageMaintenanceGuardError(
        'Connected PostgreSQL server is not the authorized test server (DB_TEST_SERVER_ID).',
      );
    }
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [plan.database.testDatabase],
    );
    if (!lock.rows[0]?.locked) {
      throw new StorageMaintenanceGuardError(
        'A test run holds the test-run lock: maintenance never runs concurrently with the suites.',
      );
    }
    return await work();
  } finally {
    await client.end(); // releases the session-level advisory lock
  }
}

export async function runStorageMaintenance(
  plan: MaintenancePlan,
  confirmed: boolean,
): Promise<MaintenanceReport> {
  const s3 = new S3Client({
    endpoint: plan.endpoint,
    region: plan.region,
    forcePathStyle: plan.forcePathStyle,
    credentials: {
      accessKeyId: plan.accessKeyId,
      secretAccessKey: plan.secretAccessKey,
    },
  });
  const report: MaintenanceReport = {
    bucket: plan.bucket,
    confirmed,
    multipartSessions: 0,
    objects: 0,
  };
  try {
    return await withTestRunLock(plan, async () => {
      await s3.send(new HeadBucketCommand({ Bucket: plan.bucket }));

      let keyMarker: string | undefined;
      let uploadIdMarker: string | undefined;
      do {
        const page = await s3.send(
          new ListMultipartUploadsCommand({
            Bucket: plan.bucket,
            KeyMarker: keyMarker,
            UploadIdMarker: uploadIdMarker,
          }),
        );
        for (const upload of page.Uploads ?? []) {
          report.multipartSessions += 1;
          if (confirmed) {
            await s3.send(
              new AbortMultipartUploadCommand({
                Bucket: plan.bucket,
                Key: upload.Key,
                UploadId: upload.UploadId,
              }),
            );
          }
        }
        keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
        uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
      } while (keyMarker);

      let token: string | undefined;
      do {
        const page = await s3.send(
          new ListObjectsV2Command({
            Bucket: plan.bucket,
            ContinuationToken: token,
          }),
        );
        const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key }));
        report.objects += keys.length;
        if (confirmed && keys.length > 0) {
          await s3.send(
            new DeleteObjectsCommand({
              Bucket: plan.bucket,
              Delete: { Objects: keys, Quiet: true },
            }),
          );
        }
        // A dry run must page with the token; a confirmed run re-lists from
        // the start after deleting, which also converges.
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return report;
    });
  } finally {
    s3.destroy();
  }
}

async function main(): Promise<void> {
  const confirmed = process.argv.includes('--confirm');
  const plan = readMaintenancePlan(process.env);
  const report = await runStorageMaintenance(plan, confirmed);
  const verb = confirmed ? 'removed' : 'would remove (dry run)';
  console.log(
    `test-storage maintenance on ${report.bucket}: ${verb} ${report.objects} object(s) and ${report.multipartSessions} multipart session(s)`,
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      `test-storage maintenance refused: ${(error as Error).name}: ${(error as Error).message}`,
    );
    process.exitCode = 1;
  });
}
