/**
 * Verification Gates 7 and 8 — URLs emitted by VideoDeliveryService against
 * the REAL pinned MinIO, exercised with plain HTTP (no SDK): Range served by
 * the storage itself (206 / 200 / 416), Content-Disposition, expiry → 403
 * and renewal resuming from the same byte. The TTL override is test-only.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ConfigType } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { BucketBootstrapService } from '../storage/bucket-bootstrap.service';
import { buildS3Clients, type S3Clients } from '../storage/s3-clients.provider';
import { originalKey } from '../storage/storage-key';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  emptyTestBucket,
  fetchPresigned,
  testStorageConfig,
} from '../test/test-storage';
import {
  buildVideoValues,
  createTestOwner,
  type TestOwner,
} from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';

jest.setTimeout(60_000);

const ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const SIZE = 256 * 1024;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const sleep = async (ms: number) =>
  await new Promise((resolve) => setTimeout(resolve, ms));

describe('VideoDeliveryService URLs × pinned MinIO (Gates 7 and 8)', () => {
  let dataSource: DataSource;
  let clients: S3Clients;
  let storage: StorageService;
  let upload: ConfigType<typeof uploadConfig>;
  let owner: TestOwner;
  let content: Buffer;
  let video: Video;

  const service = (overrides: Partial<ConfigType<typeof uploadConfig>> = {}) =>
    new VideoDeliveryService(dataSource, storage, { ...upload, ...overrides });

  beforeAll(async () => {
    dataSource = createTestDataSource(ENTITIES, { synchronize: false });
    await dataSource.initialize();
    const config = testStorageConfig();
    clients = buildS3Clients(config);
    storage = new StorageService(clients, config);
    await new BucketBootstrapService(clients, config).ensureBucket(
      config.bucket,
    );
    upload = uploadConfig();
  });

  afterAll(async () => {
    await dataSource.destroy();
    clients.internal.destroy();
    clients.singleAttempt.destroy();
    clients.publicSigner.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await emptyTestBucket(clients.internal, storage.bucket);
    owner = await createTestOwner(dataSource);
    content = randomBytes(SIZE);
    video = await dataSource.getRepository(Video).save(
      dataSource.getRepository(Video).create({
        public_id: randomBytes(8).toString('hex').slice(0, 11),
        ...buildVideoValues(owner.channel.id, {
          processing_status: 'ready',
          declared_size_bytes: SIZE,
          original_filename: 'Meu vídeo.mp4',
        }),
      }),
    );
    await storage.putObject(originalKey(video.id), content, 'video/mp4');
  });

  describe('Gate 8 — HTTP Range directly on the storage', () => {
    it('answers 206 with Content-Range, Content-Length and Accept-Ranges, serving the exact bytes', async () => {
      const { url } = await service().playbackUrl(video);

      const res = await fetchPresigned(url, {
        headers: { range: 'bytes=0-1023' },
      });

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 0-1023/${SIZE}`);
      expect(res.headers['content-length']).toBe('1024');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(sha(res.body)).toBe(sha(content.subarray(0, 1024)));
    });

    it('serves a mid-file and an open-ended range (seek) with the matching bytes', async () => {
      const { url } = await service().playbackUrl(video);

      const mid = await fetchPresigned(url, {
        headers: { range: 'bytes=100000-100099' },
      });
      const tail = await fetchPresigned(url, {
        headers: { range: `bytes=${SIZE - 10}-` },
      });

      expect(mid.status).toBe(206);
      expect(sha(mid.body)).toBe(sha(content.subarray(100000, 100100)));
      expect(tail.status).toBe(206);
      expect(tail.headers['content-range']).toBe(
        `bytes ${SIZE - 10}-${SIZE - 1}/${SIZE}`,
      );
    });

    it('answers 416 for an unsatisfiable range (without asserting Content-Range)', async () => {
      const { url } = await service().playbackUrl(video);

      const res = await fetchPresigned(url, {
        headers: { range: `bytes=${SIZE + 10}-` },
      });

      expect(res.status).toBe(416);
    });

    it('answers 200 with the whole object for a syntactically invalid range (permitted by RFC 9110)', async () => {
      const { url } = await service().playbackUrl(video);

      const res = await fetchPresigned(url, {
        headers: { range: 'bytes=abc' },
      });

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(SIZE);
    });

    it('answers 403 to an unsigned request and to a tampered signature', async () => {
      const { url } = await service().playbackUrl(video);
      const unsigned = url.split('?')[0];
      const tampered = url.replace(
        /X-Amz-Signature=[0-9a-f]+/,
        `X-Amz-Signature=${'0'.repeat(64)}`,
      );

      expect((await fetchPresigned(unsigned)).status).toBe(403);
      expect((await fetchPresigned(tampered)).status).toBe(403);
    });
  });

  describe('Gate 7 — expiry and renewal', () => {
    it('signs playback with PLAYBACK_PRESIGN_TTL_SECONDS and download with DOWNLOAD_PRESIGN_TTL_SECONDS', async () => {
      const playback = await service().playbackUrl(video);
      const download = await service().downloadUrl(video);

      expect(new URL(playback.url).searchParams.get('X-Amz-Expires')).toBe(
        String(upload.playbackPresignTtlSeconds),
      );
      expect(new URL(download.url).searchParams.get('X-Amz-Expires')).toBe(
        String(upload.downloadPresignTtlSeconds),
      );
      expect(upload.playbackPresignTtlSeconds).toBe(3600);
      expect(upload.downloadPresignTtlSeconds).toBe(900);
    });

    it('a URL answers 403 after expires_at, and a renewed URL resumes the Range from the same byte', async () => {
      const short = service({ playbackPresignTtlSeconds: 2 });
      const first = await short.playbackUrl(video);
      const before = await fetchPresigned(first.url, {
        headers: { range: 'bytes=0-1023' },
      });
      expect(before.status).toBe(206);

      // Wait past expires_at (+1 s margin for SigV4's second resolution).
      await sleep(Date.parse(first.expires_at) - Date.now() + 1500);
      const expired = await fetchPresigned(first.url, {
        headers: { range: 'bytes=1024-2047' },
      });
      expect(expired.status).toBe(403);
      expect(expired.body.toString()).toMatch(/AccessDenied|expired/i);

      const renewed = await short.playbackUrl(video);
      expect(renewed.url).not.toBe(first.url);
      const resumed = await fetchPresigned(renewed.url, {
        headers: { range: 'bytes=1024-2047' },
      });
      expect(resumed.status).toBe(206);
      expect(resumed.headers['content-range']).toBe(`bytes 1024-2047/${SIZE}`);
      expect(sha(resumed.body)).toBe(sha(content.subarray(1024, 2048)));
    });
  });

  describe('download URL', () => {
    it('makes the storage answer Content-Disposition: attachment with the RFC 6266-encoded original name', async () => {
      const { url } = await service().downloadUrl(video);

      const res = await fetchPresigned(url, {
        headers: { range: 'bytes=0-15' },
      });

      expect(res.status).toBe(206);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="Meu v_deo.mp4"; filename*=UTF-8\'\'Meu%20v%C3%ADdeo.mp4',
      );
    });
  });

  describe('credential material in the emitted URL', () => {
    it('never contains the secret key; the access key id appears only inside X-Amz-Credential (SigV4)', async () => {
      const { secretAccessKey, accessKeyId } = storageConfig();
      const { url } = await service().playbackUrl(video);
      const params = new URL(url).searchParams;

      expect(url).not.toContain(secretAccessKey);
      expect(
        params.get('X-Amz-Credential')?.startsWith(`${accessKeyId}/`),
      ).toBe(true);
      const outsideCredential = url.replace(
        /X-Amz-Credential=[^&]+/,
        'X-Amz-Credential=…',
      );
      expect(outsideCredential).not.toContain(accessKeyId);
    });
  });
});
