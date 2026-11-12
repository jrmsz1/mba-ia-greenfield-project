/**
 * Permission regression of the least-privilege identities (phase-03-videos/
 * TD-04 revision 2026-11-12; plan SI-03.4 R5 / R-AC3): the allow/deny matrix
 * of the 2026-11-12 spike, run against S3_TEST_BUCKET with the restricted
 * TEST identities only (the TD-04 profiles provisioned on the test bucket).
 * Never uses the maintenance identity or root. The accepted limitations are
 * asserted as observed facts, not as stronger isolation.
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomBytes, randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import {
  fetchPresigned,
  readTestStorageTarget,
  type TestIdentityRole,
  verifyTestBucket,
} from '../test/test-storage';
import { originalKey, thumbnailKey } from './storage-key';

jest.setTimeout(120_000);

const MIB = 1024 * 1024;
type Outcome = 'ALLOW' | 'DENY';

describe('least-privilege storage identities (test bucket)', () => {
  const target = readTestStorageTarget();
  const bucket = target.bucket;
  const config = storageConfig();
  const clients = {} as Record<TestIdentityRole, S3Client>;
  const fixtureId = randomUUID();

  const client = (role: TestIdentityRole) => clients[role];

  async function outcome(fn: () => Promise<unknown>): Promise<Outcome> {
    try {
      await fn();
      return 'ALLOW';
    } catch (error) {
      const e = error as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (e.name === 'AccessDenied' || e.$metadata?.httpStatusCode === 403) {
        return 'DENY';
      }
      throw error;
    }
  }

  async function openUpload(key: string): Promise<string> {
    const out = await client('api').send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
    );
    return out.UploadId as string;
  }

  async function uploadPart(key: string, uploadId: string): Promise<string> {
    const out = await client('api').send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: 1,
        Body: randomBytes(5 * MIB),
      }),
    );
    return out.ETag as string;
  }

  beforeAll(async () => {
    for (const role of ['api', 'worker', 'delivery'] as const) {
      clients[role] = new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: config.forcePathStyle,
        maxAttempts: 1,
        credentials: target.identities[role],
      });
    }
    await verifyTestBucket(client('api'), bucket);
    // Fixtures with the identities that are allowed to write them.
    await client('api').send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: originalKey(fixtureId),
        Body: randomBytes(256 * 1024),
      }),
    );
    await client('worker').send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: thumbnailKey(fixtureId),
        Body: randomBytes(1024),
      }),
    );
  });

  afterAll(() => {
    for (const c of Object.values(clients)) c.destroy();
  });

  // [operation, api, worker, delivery]
  const matrix: [string, Outcome, Outcome, Outcome][] = [
    ['HeadBucket', 'ALLOW', 'ALLOW', 'DENY'],
    ['CreateBucket (another bucket)', 'DENY', 'DENY', 'DENY'],
    ['CreateBucket (the configured bucket)', 'DENY', 'DENY', 'DENY'],
    [
      'ListObjectsV2 (key listing — accepted limitation)',
      'ALLOW',
      'ALLOW',
      'DENY',
    ],
    ['CreateMultipartUpload (original)', 'ALLOW', 'DENY', 'DENY'],
    ['UploadPart (direct)', 'ALLOW', 'DENY', 'DENY'],
    ['UploadPart via a URL signed by the identity', 'ALLOW', 'DENY', 'DENY'],
    ['ListParts', 'ALLOW', 'ALLOW', 'DENY'],
    ['ListMultipartUploads (key prefix)', 'ALLOW', 'ALLOW', 'DENY'],
    ['CompleteMultipartUpload', 'ALLOW', 'DENY', 'DENY'],
    ['AbortMultipartUpload', 'ALLOW', 'ALLOW', 'DENY'],
    ['HeadObject (original)', 'ALLOW', 'ALLOW', 'ALLOW'],
    ['GetObject (original)', 'ALLOW', 'ALLOW', 'ALLOW'],
    ['GetObject (thumbnail)', 'DENY', 'DENY', 'DENY'],
    [
      'Presigned GET of an original with Range → 206',
      'ALLOW',
      'ALLOW',
      'ALLOW',
    ],
    [
      'PutObject (original, plain PUT — accepted limitation)',
      'ALLOW',
      'DENY',
      'DENY',
    ],
    ['PutObject (thumbnail)', 'DENY', 'ALLOW', 'DENY'],
    ['PutObject (outside videos/)', 'DENY', 'DENY', 'DENY'],
    ['DeleteObject (original)', 'ALLOW', 'ALLOW', 'DENY'],
  ];

  const roles = ['api', 'worker', 'delivery'] as const;

  async function run(op: string, role: TestIdentityRole): Promise<Outcome> {
    const c = client(role);
    const id = `${role}-${randomUUID()}`;
    const key = originalKey(id);
    switch (op) {
      case 'HeadBucket':
        return await outcome(() =>
          c.send(new HeadBucketCommand({ Bucket: bucket })),
        );
      case 'CreateBucket (another bucket)':
        return await outcome(() =>
          c.send(
            new CreateBucketCommand({
              Bucket: `other-${randomBytes(4).toString('hex')}-test`,
            }),
          ),
        );
      case 'CreateBucket (the configured bucket)':
        return await outcome(() =>
          c.send(new CreateBucketCommand({ Bucket: bucket })),
        );
      case 'ListObjectsV2 (key listing — accepted limitation)':
        return await outcome(() =>
          c.send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: 'videos/' }),
          ),
        );
      case 'CreateMultipartUpload (original)': {
        const result = await outcome(() =>
          c.send(
            new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
          ),
        );
        await abortAll(key);
        return result;
      }
      case 'UploadPart (direct)': {
        const uploadId = await openUpload(key);
        const result = await outcome(() =>
          c.send(
            new UploadPartCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: 1,
              Body: randomBytes(1024),
            }),
          ),
        );
        await abortAll(key);
        return result;
      }
      case 'UploadPart via a URL signed by the identity': {
        const uploadId = await openUpload(key);
        const url = await getSignedUrl(
          signerFor(role),
          new UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: 1,
          }),
          { expiresIn: 300 },
        );
        const res = await fetchPresigned(url, {
          method: 'PUT',
          body: randomBytes(1024),
        });
        await abortAll(key);
        if (res.status === 200) return 'ALLOW';
        if (res.status === 403) return 'DENY';
        throw new Error(`unexpected HTTP ${res.status}`);
      }
      case 'ListParts': {
        const uploadId = await openUpload(key);
        const result = await outcome(() =>
          c.send(
            new ListPartsCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
            }),
          ),
        );
        await abortAll(key);
        return result;
      }
      case 'ListMultipartUploads (key prefix)':
        return await outcome(() =>
          c.send(
            new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }),
          ),
        );
      case 'CompleteMultipartUpload': {
        const uploadId = await openUpload(key);
        const etag = await uploadPart(key, uploadId);
        const result = await outcome(() =>
          c.send(
            new CompleteMultipartUploadCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              MultipartUpload: { Parts: [{ PartNumber: 1, ETag: etag }] },
            }),
          ),
        );
        await abortAll(key);
        return result;
      }
      case 'AbortMultipartUpload': {
        const uploadId = await openUpload(key);
        const result = await outcome(() =>
          c.send(
            new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
            }),
          ),
        );
        await abortAll(key);
        return result;
      }
      case 'HeadObject (original)':
        return await outcome(() =>
          c.send(
            new HeadObjectCommand({
              Bucket: bucket,
              Key: originalKey(fixtureId),
            }),
          ),
        );
      case 'GetObject (original)':
        return await outcome(async () => {
          const out = await c.send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: originalKey(fixtureId),
            }),
          );
          await out.Body?.transformToByteArray();
        });
      case 'GetObject (thumbnail)':
        return await outcome(() =>
          c.send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: thumbnailKey(fixtureId),
            }),
          ),
        );
      case 'Presigned GET of an original with Range → 206': {
        const url = await getSignedUrl(
          signerFor(role),
          new GetObjectCommand({ Bucket: bucket, Key: originalKey(fixtureId) }),
          { expiresIn: 300 },
        );
        const res = await fetchPresigned(url, {
          headers: { range: 'bytes=0-1023' },
        });
        if (res.status === 206) return 'ALLOW';
        if (res.status === 403) return 'DENY';
        throw new Error(`unexpected HTTP ${res.status}`);
      }
      case 'PutObject (original, plain PUT — accepted limitation)':
        return await outcome(() =>
          c.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: randomBytes(1024),
            }),
          ),
        );
      case 'PutObject (thumbnail)':
        return await outcome(() =>
          c.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: thumbnailKey(id),
              Body: randomBytes(1024),
            }),
          ),
        );
      case 'PutObject (outside videos/)':
        return await outcome(() =>
          c.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: `other/${id}`,
              Body: randomBytes(16),
            }),
          ),
        );
      case 'DeleteObject (original)': {
        const victim = originalKey(`victim-${id}`);
        await client('api').send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: victim,
            Body: randomBytes(64),
          }),
        );
        return await outcome(() =>
          c.send(new DeleteObjectCommand({ Bucket: bucket, Key: victim })),
        );
      }
      default:
        throw new Error(`unknown operation ${op}`);
    }
  }

  /** A signer on the public endpoint with the given identity. */
  function signerFor(role: TestIdentityRole): S3Client {
    return new S3Client({
      endpoint: config.publicEndpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: target.identities[role],
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }

  /** Aborts the sessions of this case's own key (API identity). */
  async function abortAll(key: string): Promise<void> {
    const page = await client('api').send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }),
    );
    for (const upload of page.Uploads ?? []) {
      if (upload.Key !== key) continue;
      await client('api').send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: upload.UploadId,
        }),
      );
    }
  }

  describe.each(matrix)('%s', (op, ...expected) => {
    it.each(roles.map((role, i) => [role, expected[i]] as const))(
      '%s → %s',
      async (role, want) => {
        expect(await run(op, role)).toBe(want);
      },
    );
  });

  describe('cross-identity multipart (session opened by the API)', () => {
    let key: string;
    let uploadId: string;
    let etag: string;

    beforeEach(async () => {
      key = originalKey(`cross-${randomUUID()}`);
      uploadId = await openUpload(key);
      etag = await uploadPart(key, uploadId);
    });

    afterEach(async () => {
      await abortAll(key);
    });

    it('lets the worker list and abort it (reconciler)', async () => {
      expect(
        await outcome(() =>
          client('worker').send(
            new ListPartsCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
            }),
          ),
        ),
      ).toBe('ALLOW');
      expect(
        await outcome(() =>
          client('worker').send(
            new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
            }),
          ),
        ),
      ).toBe('ALLOW');
    });

    it('denies the worker uploading into or completing it, and the delivery identity listing it', async () => {
      expect(
        await outcome(() =>
          client('worker').send(
            new UploadPartCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: 2,
              Body: randomBytes(1024),
            }),
          ),
        ),
      ).toBe('DENY');
      expect(
        await outcome(() =>
          client('worker').send(
            new CompleteMultipartUploadCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              MultipartUpload: { Parts: [{ PartNumber: 1, ETag: etag }] },
            }),
          ),
        ),
      ).toBe('DENY');
      expect(
        await outcome(() =>
          client('delivery').send(
            new ListPartsCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
            }),
          ),
        ),
      ).toBe('DENY');
    });

    it('rejects a part URL replayed as a plain PUT of the original', async () => {
      const url = await getSignedUrl(
        signerFor('api'),
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: 1,
        }),
        { expiresIn: 300 },
      );
      const stripped = url.replace(/([?&])(partNumber|uploadId)=[^&]*/g, '$1');

      const res = await fetchPresigned(stripped, {
        method: 'PUT',
        body: randomBytes(16),
      });

      expect(res.status).toBe(403);
    });
  });

  describe('ListBuckets (observed behavior, not a guarantee)', () => {
    it.each(['api', 'worker'] as const)(
      '%s sees only the test bucket',
      async (role) => {
        const out = await client(role).send(new ListBucketsCommand({}));

        expect((out.Buckets ?? []).map((b) => b.Name)).toEqual([bucket]);
      },
    );

    it('delivery is denied', async () => {
      expect(
        await outcome(() =>
          client('delivery').send(new ListBucketsCommand({})),
        ),
      ).toBe('DENY');
    });
  });
});
