import {
  AbortMultipartUploadCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  ListMultipartUploadsCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { ConfigType } from '@nestjs/config';
import type storageConfig from '../config/storage.config';
import {
  emptyTestBucket,
  fetchPresigned,
  testStorageConfig,
  TestStorageGuardError,
} from '../test/test-storage';
import { BucketBootstrapService } from './bucket-bootstrap.service';
import { confirmUploadsGone } from './multipart-cleanup';
import { buildS3Clients, type S3Clients } from './s3-clients.provider';
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
  let bootstrap: BucketBootstrapService;

  async function abortAllUploads(): Promise<void> {
    const page = await clients.internal.send(
      new ListMultipartUploadsCommand({ Bucket: config.bucket }),
    );
    for (const upload of page.Uploads ?? []) {
      await clients.internal.send(
        new AbortMultipartUploadCommand({
          Bucket: config.bucket,
          Key: upload.Key,
          UploadId: upload.UploadId,
        }),
      );
    }
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
    bootstrap = new BucketBootstrapService(clients, config);
    await bootstrap.ensureBucket(config.bucket);
  });

  afterEach(async () => {
    await abortAllUploads();
    await emptyTestBucket(clients.internal, config.bucket);
  });

  afterAll(() => {
    clients.internal.destroy();
    clients.singleAttempt.destroy();
    clients.publicSigner.destroy();
  });

  it('creates a missing bucket at startup', async () => {
    const bucket = `bootstrap-${randomBytes(4).toString('hex')}-test`;
    const scoped = new BucketBootstrapService(clients, { ...config, bucket });

    await scoped.onApplicationBootstrap();

    await expect(
      clients.internal.send(new HeadBucketCommand({ Bucket: bucket })),
    ).resolves.toBeDefined();
    await clients.internal.send(new DeleteBucketCommand({ Bucket: bucket }));
  });

  it('signs part URLs for the public host without checksum parameters, and a 5 MiB PUT returns an ETag', async () => {
    const key = originalKey(randomUUID());
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
    const key = originalKey(randomUUID());
    await storage.putObject(key, Buffer.from('internal-read'), 'text/plain');

    const url = await storage.presignInternalGet(key, 60);
    const response = await fetch(url);

    expect(new URL(url).host).toBe(new URL(config.endpoint).host);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('internal-read');
  });

  it('lists every part of an upload across pages, in order', async () => {
    const key = originalKey(randomUUID());
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
    const key = originalKey(randomUUID());
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
      const key = originalKey(randomUUID());
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
      const key = originalKey(randomUUID());
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
      down.internal.destroy();
      down.singleAttempt.destroy();
      down.publicSigner.destroy();
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
      paused.internal.destroy();
      paused.singleAttempt.destroy();
      paused.publicSigner.destroy();
    });
  });

  it('refuses to empty a bucket that is not a test bucket', async () => {
    await expect(
      emptyTestBucket(clients.internal, 'streamtube-videos'),
    ).rejects.toBeInstanceOf(TestStorageGuardError);
  });
});
