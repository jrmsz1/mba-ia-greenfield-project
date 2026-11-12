import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import { request } from 'node:http';
import {
  TEST_RESOURCE_PATTERNS,
  VIDEO_ENV_DEFAULTS,
} from '../config/video.constants';
import storageConfig from '../config/storage.config';

export class TestStorageGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestStorageGuardError';
  }
}

/** Refuses any bucket that is not a test bucket (phase-03-videos/TD-15). */
export function assertTestBucket(bucket: string): void {
  if (!TEST_RESOURCE_PATTERNS.S3_BUCKET.test(bucket)) {
    throw new TestStorageGuardError(
      `Refusing to use bucket "${bucket}" in tests: test buckets must match ${TEST_RESOURCE_PATTERNS.S3_BUCKET.source}.`,
    );
  }
}

/**
 * The restricted test identities (phase-03-videos/TD-15, TD-16 revisions of
 * 2026-11-12): the TD-04 profiles, provisioned on S3_TEST_BUCKET only.
 */
export const TEST_STORAGE_IDENTITY_KEYS = {
  api: ['S3_TEST_API_ACCESS_KEY_ID', 'S3_TEST_API_SECRET_ACCESS_KEY'],
  worker: ['S3_TEST_WORKER_ACCESS_KEY_ID', 'S3_TEST_WORKER_SECRET_ACCESS_KEY'],
  delivery: [
    'S3_TEST_DELIVERY_ACCESS_KEY_ID',
    'S3_TEST_DELIVERY_SECRET_ACCESS_KEY',
  ],
} as const;

/** Held only by the external maintenance container, never by a test process. */
export const TEST_MAINTENANCE_KEYS = [
  'S3_TEST_MAINTENANCE_ACCESS_KEY_ID',
  'S3_TEST_MAINTENANCE_SECRET_ACCESS_KEY',
] as const;

export type TestIdentityRole = keyof typeof TEST_STORAGE_IDENTITY_KEYS;

export interface TestStorageIdentity {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface TestStorageTarget {
  bucket: string;
  identities: Record<TestIdentityRole, TestStorageIdentity>;
}

interface OperationalStorageEnv {
  bucket?: string;
  accessKeyId?: string;
  deliveryAccessKeyId?: string;
}

/**
 * Operational values replaced by `applyTestStorageEnv()`, keyed by the env
 * object it rewrote. Module-private (like the DB guard) so a repeated call
 * still compares against the developer's configuration, not the rewritten one.
 */
const replacedOperationalEnv = new WeakMap<
  NodeJS.ProcessEnv,
  OperationalStorageEnv
>();

function operationalEnv(env: NodeJS.ProcessEnv): OperationalStorageEnv {
  return (
    replacedOperationalEnv.get(env) ?? {
      bucket: env.S3_BUCKET?.trim() || undefined,
      accessKeyId: env.S3_ACCESS_KEY_ID?.trim() || undefined,
      deliveryAccessKeyId: env.S3_DELIVERY_ACCESS_KEY_ID?.trim() || undefined,
    }
  );
}

function readIdentity(
  env: NodeJS.ProcessEnv,
  role: TestIdentityRole,
): TestStorageIdentity {
  const [idKey, secretKey] = TEST_STORAGE_IDENTITY_KEYS[role];
  const accessKeyId = env[idKey]?.trim();
  const secretAccessKey = env[secretKey]?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new TestStorageGuardError(
      `${idKey} and ${secretKey} must be set for tests (restricted test identity, provisioned on S3_TEST_BUCKET). There is no fallback to the operational or root credentials.`,
    );
  }
  return { accessKeyId, secretAccessKey };
}

/**
 * Validates the test storage target without touching the network or `env`:
 * explicit test context, no maintenance credentials in the process, a test
 * bucket distinct from the operational one, and three complete, distinct
 * test identities that differ from the operational ones. Fails closed.
 */
export function readTestStorageTarget(
  env: NodeJS.ProcessEnv = process.env,
): TestStorageTarget {
  if (env.NODE_ENV !== 'test') {
    throw new TestStorageGuardError(
      `Test storage identities are mapped only in the explicit test context (NODE_ENV=test, got "${env.NODE_ENV ?? ''}").`,
    );
  }
  const leaked = TEST_MAINTENANCE_KEYS.filter((key) => env[key] !== undefined);
  if (leaked.length > 0) {
    throw new TestStorageGuardError(
      `${leaked.join(', ')} must not reach a process under test: storage maintenance runs only in the external maintenance container.`,
    );
  }

  const bucket =
    env.S3_TEST_BUCKET?.trim() || VIDEO_ENV_DEFAULTS.S3_TEST_BUCKET;
  assertTestBucket(bucket);
  const operational = operationalEnv(env);
  if (operational.bucket === bucket) {
    throw new TestStorageGuardError(
      `S3_BUCKET and S3_TEST_BUCKET are both "${bucket}": the test bucket must be separate from the operational one.`,
    );
  }

  const identities = {
    api: readIdentity(env, 'api'),
    worker: readIdentity(env, 'worker'),
    delivery: readIdentity(env, 'delivery'),
  };
  const ids = Object.values(identities).map((i) => i.accessKeyId);
  if (new Set(ids).size !== ids.length) {
    throw new TestStorageGuardError(
      'The test API, worker and delivery identities must be distinct.',
    );
  }
  const operationalIds = [
    operational.accessKeyId,
    operational.deliveryAccessKeyId,
  ].filter((id): id is string => id !== undefined);
  if (ids.some((id) => operationalIds.includes(id))) {
    throw new TestStorageGuardError(
      'A test identity equals an operational identity (S3_ACCESS_KEY_ID / S3_DELIVERY_ACCESS_KEY_ID); test identities must be separate.',
    );
  }
  return { bucket, identities };
}

/**
 * Test context only (setupFiles, mirrors applyTestDatabaseEnv): points
 * S3_BUCKET at S3_TEST_BUCKET, the process credentials at the restricted test
 * API identity and the delivery signer at the test delivery identity, so
 * anything booting the StorageModule in tests uses only the test bucket and
 * the test identities. Idempotent; never used by production startup.
 */
export function applyTestStorageEnv(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const target = readTestStorageTarget(env);
  if (!replacedOperationalEnv.has(env)) {
    replacedOperationalEnv.set(env, operationalEnv(env));
  }
  env.S3_BUCKET = target.bucket;
  env.S3_ACCESS_KEY_ID = target.identities.api.accessKeyId;
  env.S3_SECRET_ACCESS_KEY = target.identities.api.secretAccessKey;
  env.S3_DELIVERY_ACCESS_KEY_ID = target.identities.delivery.accessKeyId;
  env.S3_DELIVERY_SECRET_ACCESS_KEY =
    target.identities.delivery.secretAccessKey;
}

/**
 * `storageConfig` for a process role, pointed at `S3_TEST_BUCKET` with that
 * role's restricted test identity: `api` (API identity + delivery signer) or
 * `worker` (worker identity, no delivery signer — as in production).
 */
export function testStorageConfig(
  role: 'api' | 'worker' = 'api',
): ConfigType<typeof storageConfig> {
  const target = readTestStorageTarget(process.env);
  const base = { ...storageConfig(), bucket: target.bucket };
  if (role === 'api') {
    return {
      ...base,
      accessKeyId: target.identities.api.accessKeyId,
      secretAccessKey: target.identities.api.secretAccessKey,
      deliveryAccessKeyId: target.identities.delivery.accessKeyId,
      deliverySecretAccessKey: target.identities.delivery.secretAccessKey,
    };
  }
  return {
    ...base,
    accessKeyId: target.identities.worker.accessKeyId,
    secretAccessKey: target.identities.worker.secretAccessKey,
    deliveryAccessKeyId: '',
    deliverySecretAccessKey: '',
  };
}

/** Environment for a spawned worker process under test: worker identity only. */
export function testWorkerProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const target = readTestStorageTarget(env);
  const child: NodeJS.ProcessEnv = {
    ...env,
    S3_BUCKET: target.bucket,
    S3_ACCESS_KEY_ID: target.identities.worker.accessKeyId,
    S3_SECRET_ACCESS_KEY: target.identities.worker.secretAccessKey,
  };
  delete child.S3_DELIVERY_ACCESS_KEY_ID;
  delete child.S3_DELIVERY_SECRET_ACCESS_KEY;
  return child;
}

/**
 * Verifies — never creates — the test bucket with the given client (its
 * restricted identity). Missing, denied or unreachable fails closed. Suites
 * never empty or reset storage: each test isolates its objects under the keys
 * of the videos it creates; cleanup belongs to the external maintenance
 * container.
 */
export async function verifyTestBucket(
  client: S3Client,
  bucket: string,
): Promise<void> {
  assertTestBucket(bucket);
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    const reason = status ? `HTTP ${status}` : (error as Error).name;
    throw new TestStorageGuardError(
      `Test bucket "${bucket}" is not accessible with the test identity (${reason}). Provision it with the provisioning container; tests never create it.`,
    );
  }
}

export interface PresignedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * Sends a request to a URL presigned for `S3_PUBLIC_ENDPOINT` from inside the
 * container: connects to `S3_ENDPOINT` but keeps the public `Host` header the
 * SigV4 signature is bound to — exactly what a client on the host does.
 */
export async function fetchPresigned(
  url: string,
  init: {
    method?: string;
    body?: Buffer;
    headers?: Record<string, string>;
  } = {},
): Promise<PresignedResponse> {
  const config = storageConfig();
  const target = new URL(url);
  const internal = new URL(config.endpoint);
  const publicHost = new URL(config.publicEndpoint).host;
  if (target.host !== publicHost && target.host !== internal.host) {
    throw new Error(`Unexpected presigned host ${target.host}`);
  }
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        host: internal.hostname,
        port: internal.port,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? 'GET',
        headers: {
          ...init.headers,
          host: target.host,
          ...(init.body ? { 'content-length': String(init.body.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}
