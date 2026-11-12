import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
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
 * Points S3_BUCKET at S3_TEST_BUCKET (mirrors applyTestDatabaseEnv), so
 * anything booting the StorageModule in tests — including the bucket
 * bootstrap — only touches the test bucket.
 */
export function applyTestStorageEnv(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const bucket =
    env.S3_TEST_BUCKET?.trim() || VIDEO_ENV_DEFAULTS.S3_TEST_BUCKET;
  assertTestBucket(bucket);
  env.S3_BUCKET = bucket;
}

/** `storageConfig` pointed at `S3_TEST_BUCKET`, verified before any use. */
export function testStorageConfig(): ReturnType<typeof storageConfig> {
  const config = storageConfig();
  assertTestBucket(config.testBucket);
  return { ...config, bucket: config.testBucket };
}

/** Deletes every object of the test bucket (refuses any other bucket). */
export async function emptyTestBucket(
  client: S3Client,
  bucket: string,
): Promise<void> {
  assertTestBucket(bucket);
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key as string }));
    if (keys.length > 0) {
      await client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }),
      );
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
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
