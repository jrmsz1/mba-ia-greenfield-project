import {
  AbortMultipartUploadCommand,
  HeadBucketCommand,
  ListMultipartUploadsCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { ConfigType } from '@nestjs/config';
import type storageConfig from '../config/storage.config';
import {
  fetchPresigned,
  readTestStorageTarget,
  testStorageConfig,
  TestStorageGuardError,
  verifyTestBucket,
} from '../test/test-storage';
import {
  BucketUnavailableError,
  BucketVerificationService,
} from './bucket-verification.service';
import { confirmUploadsGone } from './multipart-cleanup';
import {
  buildS3Clients,
  destroyS3Clients,
  type S3Clients,
} from './s3-clients.provider';
import { StorageUnavailableError, UploadNotFoundError } from './storage-errors';
import { originalKey } from './storage-key';
import { STORAGE_TIMEOUTS } from './storage.constants';
import { StorageService } from './storage.service';

jest.setTimeout(60_000);

const MIB = 1024 * 1024;

describe('StorageService against the pinned MinIO', () => {
  let config: ConfigType<typeof storageConfig>;
  let clients: S3Clients;
  let storage: StorageService;
  /** Keys created by the running test: the only sessions it may abort. */
  const ownKeys = new Set<string>();

  /** A fresh, exclusive key for this test (no bucket-wide assumption). */
  function newKey(): string {
    const key = originalKey(randomUUID());
    ownKeys.add(key);
    return key;
  }

  /**
   * Aborts only the sessions this test opened on its own keys; objects and
   * other tests' sessions are left alone (cleanup is the external maintenance
   * container's, phase-03-videos/TD-15 revisions of 2026-11-12).
   */
  async function abortOwnUploads(): Promise<void> {
    for (const key of ownKeys) {
      const page = await clients.internal.send(
        new ListMultipartUploadsCommand({ Bucket: config.bucket, Prefix: key }),
      );
      for (const upload of page.Uploads ?? []) {
        if (upload.Key !== key) continue;
        await clients.internal.send(
          new AbortMultipartUploadCommand({
            Bucket: config.bucket,
            Key: upload.Key,
            UploadId: upload.UploadId,
          }),
        );
      }
    }
    ownKeys.clear();
  }

  async function uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<string> {
    const output = await clients.internal.send(
      new UploadPartCommand({
        Bucket: config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
      }),
    );
    return output.ETag as string;
  }

  beforeAll(async () => {
    config = testStorageConfig();
    clients = buildS3Clients(config);
    storage = new StorageService(clients, config);
    await verifyTestBucket(clients.internal, config.bucket);
  });

  afterEach(async () => {
    await abortOwnUploads();
  });

  afterAll(() => {
    destroyS3Clients(clients);
  });

  describe('bucket verification at startup (HeadBucket only)', () => {
    it('accepts the provisioned bucket', async () => {
      const verifier = new BucketVerificationService(clients, config);

      await expect(verifier.onApplicationBootstrap()).resolves.toBeUndefined();
    });

    it('fails fast naming a missing bucket and never creates it', async () => {
      const bucket = `absent-${randomBytes(4).toString('hex')}-test`;
      const verifier = new BucketVerificationService(clients, {
        ...config,
        bucket,
      });

      const error: unknown = await verifier
        .onApplicationBootstrap()
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BucketUnavailableError);
      expect((error as Error).message).toContain(bucket);
      // Still absent: the verification sent no CreateBucket.
      await expect(
        clients.internal.send(new HeadBucketCommand({ Bucket: bucket })),
      ).rejects.toBeDefined();
    });
  });

  it('signs part URLs with the API identity and delivery URLs with the delivery identity', async () => {
    const target = readTestStorageTarget();
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'binding-id');

    const partUrl = await storage.presignUploadPart(key, uploadId, 1, 900);
    const getUrl = await storage.presignGet(key, 900);

    const signer = (url: string) =>
      (new URL(url).searchParams.get('X-Amz-Credential') ?? '').split('/')[0];
    expect(signer(partUrl)).toBe(target.identities.api.accessKeyId);
    expect(signer(getUrl)).toBe(target.identities.delivery.accessKeyId);
  });

  it('cannot sign a delivery URL without the delivery identity (the worker)', async () => {
    const workerConfig = testStorageConfig('worker');
    const workerClients = buildS3Clients(workerConfig);
    const workerStorage = new StorageService(workerClients, workerConfig);

    await expect(workerStorage.presignGet(newKey(), 60)).rejects.toThrow(
      'delivery identity',
    );
    expect(workerClients.deliverySigner).toBeUndefined();
    destroyS3Clients(workerClients);
  });

  it('signs part URLs for the public host without checksum parameters, and a 5 MiB PUT returns an ETag', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'binding-1');

    const url = await storage.presignUploadPart(key, uploadId, 1, 900);
    const response = await fetchPresigned(url, {
      method: 'PUT',
      body: randomBytes(5 * MIB),
    });

    expect(new URL(url).host).toBe(new URL(config.publicEndpoint).host);
    expect(url).not.toContain('x-amz-checksum');
    expect(response.status).toBe(200);
    expect(response.headers.etag).toEqual(
      expect.stringMatching(/^"[0-9a-f]{32}"$/),
    );
  });

  it('signs internal GET URLs for the internal host, readable from the API container', async () => {
    const key = newKey();
    await storage.putObject(key, Buffer.from('internal-read'), 'text/plain');

    const url = await storage.presignInternalGet(key, 60);
    const response = await fetch(url);

    expect(new URL(url).host).toBe(new URL(config.endpoint).host);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('internal-read');
  });

  it('lists every part of an upload across pages, in order', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'binding-2');
    const etags = [
      await uploadPart(key, uploadId, 1, Buffer.from('one')),
      await uploadPart(key, uploadId, 2, Buffer.from('two!')),
      await uploadPart(key, uploadId, 3, Buffer.from('three')),
    ];

    const parts = await storage.listParts(key, uploadId, 2);

    expect(parts).toEqual([
      { partNumber: 1, sizeBytes: 3, etag: etags[0] },
      { partNumber: 2, sizeBytes: 4, etag: etags[1] },
      { partNumber: 3, sizeBytes: 5, etag: etags[2] },
    ]);
  });

  it('completes an upload, exposes the binding metadata and reports NoSuchUpload afterwards', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'binding-3');
    const etag1 = await uploadPart(key, uploadId, 1, randomBytes(5 * MIB));
    const etag2 = await uploadPart(key, uploadId, 2, Buffer.from('tail'));

    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag1 },
      { partNumber: 2, etag: etag2 },
    ]);

    expect(await storage.headObject(key)).toMatchObject({
      contentLength: 5 * MIB + 4,
      uploadBinding: 'binding-3',
    });
    await expect(storage.listParts(key, uploadId)).rejects.toBeInstanceOf(
      UploadNotFoundError,
    );
    expect(await storage.headObject(originalKey(randomUUID()))).toBeNull();
  });

  describe('confirmUploadsGone', () => {
    it('returns aborted for a key with two open sessions, one of them unknown', async () => {
      const key = newKey();
      const known = await storage.createMultipartUpload(key, 'binding-4');
      const unknown = await storage.createMultipartUpload(key, 'binding-4');
      await uploadPart(key, unknown, 1, Buffer.from('in-flight'));

      const outcome = await confirmUploadsGone(
        storage,
        key,
        [known],
        'binding-4',
      );

      expect(outcome).toBe('aborted');
      expect(await storage.listMultipartUploads(key)).toEqual([]);
    });

    it('returns completed for a key whose object carries the expected binding', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'binding-5');
      const etag = await uploadPart(key, uploadId, 1, Buffer.from('only-part'));
      await storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag },
      ]);

      expect(
        await confirmUploadsGone(storage, key, [uploadId], 'binding-5'),
      ).toBe('completed');
      expect(
        await confirmUploadsGone(storage, key, [uploadId], 'other-binding'),
      ).toBe('indeterminate');
    });

    it('returns indeterminate when storage is unreachable', async () => {
      const down = buildS3Clients({ ...config, endpoint: 'http://minio:1' });
      const unreachable = new StorageService(down, config);

      expect(
        await confirmUploadsGone(
          unreachable,
          originalKey(randomUUID()),
          ['some-upload'],
          'binding-6',
          { maxAbortAttempts: 1, backoffMs: 1 },
        ),
      ).toBe('indeterminate');
      destroyS3Clients(down);
    });
  });

  describe('timeout policy', () => {
    let server: Server;
    let connections: number;
    const sockets = new Set<Socket>();

    beforeAll(async () => {
      connections = 0;
      server = createServer((socket) => {
        connections += 1;
        sockets.add(socket); // accept and never answer: a paused storage
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
    });

    afterAll(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });

    it('bounds CreateMultipartUpload to the request timeout, classifies it ambiguous and does not resend it', async () => {
      const address = server.address() as { port: number };
      const paused = buildS3Clients({
        ...config,
        endpoint: `http://127.0.0.1:${address.port}`,
      });
      const pausedStorage = new StorageService(paused, config);
      const startedAt = Date.now();

      const error: unknown = await pausedStorage
        .createMultipartUpload(originalKey(randomUUID()), 'binding-7')
        .catch((e: unknown) => e);

      const elapsed = Date.now() - startedAt;
      expect(error).toBeInstanceOf(StorageUnavailableError);
      expect((error as StorageUnavailableError).kind).toBe('ambiguous');
      expect(elapsed).toBeLessThanOrEqual(STORAGE_TIMEOUTS.REQUEST_MS + 2_000);
      expect(connections).toBe(1);
      destroyS3Clients(paused);
    });
  });

  it('refuses to use a bucket that is not a test bucket', async () => {
    await expect(
      verifyTestBucket(clients.internal, 'streamtube-videos'),
    ).rejects.toBeInstanceOf(TestStorageGuardError);
  });
});
