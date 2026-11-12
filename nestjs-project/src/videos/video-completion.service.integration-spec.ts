/**
 * SI-03.10 — completion protocol against the pinned MinIO and PostgreSQL.
 * Verification Gate 4 (identity/integrity proof of the final object, lost
 * response, 200 with embedded error, reordered manifest, replaced part) and
 * Gate 5 (concurrent completions). A fault proxy sits in front of
 * CompleteMultipartUpload only; every other call hits MinIO directly.
 */
import { UploadPartCommand } from '@aws-sdk/client-s3';
import { type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import uploadConfig from '../config/upload.config';
import workerConfig from '../config/worker.config';
import { JobPublisherService } from '../queue/job-publisher.service';
import { PGBOSS, QUEUES } from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { BucketBootstrapService } from '../storage/bucket-bootstrap.service';
import { buildS3Clients, type S3Clients } from '../storage/s3-clients.provider';
import { originalKey } from '../storage/storage-key';
import { StorageUnavailableError } from '../storage/storage-errors';
import { StorageService, type ManifestPart } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestTypeOrmModule,
} from '../test/create-test-data-source';
import { startS3FaultProxy, type S3FaultProxy } from '../test/s3-fault-proxy';
import { emptyTestBucket, testStorageConfig } from '../test/test-storage';
import { createTestOwner, type TestOwner } from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { expectedMultipartEtag } from './completion-proof';
import { Video } from './entities/video.entity';
import { UploadRecoveryService } from './upload-recovery.service';
import { VideoCompletionService } from './video-completion.service';
import { VideoUploadService } from './video-upload.service';
import {
  InvalidVideoStateException,
  ManifestInvalidException,
  StorageUnavailableException,
  UploadPartsMismatchException,
} from './video.exceptions';

jest.setTimeout(90_000);

const ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MIB = 1024 * 1024;
const SIZE = 12 * MIB; // parts: 5 MiB, 5 MiB, 2 MiB

describe('VideoCompletionService (pinned MinIO + PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let boss: PgBoss;
  let proxy: S3FaultProxy;
  let direct: S3Clients;
  let viaProxy: S3Clients;
  let storage: StorageService;
  let uploads: VideoUploadService;
  let completion: VideoCompletionService;
  let owner: TestOwner;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, queueConfig, workerConfig],
        }),
        createTestTypeOrmModule(ENTITIES, { synchronize: false }),
        QueueModule.register({ role: 'api' }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    boss = app.get<PgBoss>(PGBOSS);

    const config = testStorageConfig();
    direct = buildS3Clients(config);
    proxy = await startS3FaultProxy(config.endpoint);
    viaProxy = buildS3Clients({ ...config, endpoint: proxy.endpoint });
    // Complete goes through the proxy; everything else straight to MinIO.
    storage = new StorageService(
      { ...direct, singleAttempt: viaProxy.singleAttempt },
      config,
    );
    await new BucketBootstrapService(direct, config).ensureBucket(
      config.bucket,
    );

    const upload = { ...uploadConfig(), partSizeBytes: 5 * MIB };
    uploads = new VideoUploadService(dataSource, storage, upload);
    const recovery = new UploadRecoveryService(
      dataSource,
      storage,
      app.get(JobPublisherService),
    );
    completion = new VideoCompletionService(dataSource, storage, recovery);
  });

  afterAll(async () => {
    await app.close();
    await proxy.close();
    for (const c of [direct, viaProxy]) {
      c.internal.destroy();
      c.singleAttempt.destroy();
      c.publicSigner.destroy();
    }
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanAllTables(dataSource);
    await emptyTestBucket(direct.internal, storage.bucket);
    await boss.deleteAllJobs(QUEUES.VIDEO_PROCESS);
    owner = await createTestOwner(dataSource);
  });

  /** Starts an upload and sends its three parts like a browser would. */
  async function uploadedVideo(): Promise<{
    video: Video;
    manifest: ManifestPart[];
  }> {
    const { video } = await uploads.start(
      owner.user.id,
      `k-${randomBytes(4).toString('hex')}`,
      { filename: 'clip.mp4', sizeBytes: SIZE },
    );
    const sizes = [5 * MIB, 5 * MIB, 2 * MIB];
    const manifest: ManifestPart[] = [];
    for (const [i, size] of sizes.entries()) {
      manifest.push({
        partNumber: i + 1,
        etag: await putPart(video, i + 1, randomBytes(size)),
      });
    }
    return { video, manifest };
  }

  async function putPart(
    video: Video,
    partNumber: number,
    body: Buffer,
  ): Promise<string> {
    const out = await direct.internal.send(
      new UploadPartCommand({
        Bucket: storage.bucket,
        Key: originalKey(video.id),
        UploadId: video.upload_id as string,
        PartNumber: partNumber,
        Body: body,
      }),
    );
    return out.ETag as string;
  }

  const row = async (id: string) =>
    await dataSource.getRepository(Video).findOneByOrFail({ id });

  const jobsFor = async (videoId: string) =>
    await boss.findJobs(QUEUES.VIDEO_PROCESS, { key: videoId });

  it('completes a verified manifest: uploaded + exactly one job carrying only the video id', async () => {
    const { video, manifest } = await uploadedVideo();

    const result = await completion.complete(video, manifest);

    expect(result).toEqual({ outcome: 'done', processingStatus: 'uploaded' });
    const jobs = await jobsFor(video.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual({ videoId: video.id });
  });

  it('records whether the final ETag is deterministic for the manifest (Gate 4 evidence)', async () => {
    const { video, manifest } = await uploadedVideo();
    await completion.complete(video, manifest);

    const head = await storage.headObject(originalKey(video.id));

    expect(head?.etag.replace(/"/g, '')).toBe(expectedMultipartEtag(manifest));
    expect(head?.contentLength).toBe(SIZE);
  });

  it('rejects a manifest whose ETag does not match storage, without calling Complete', async () => {
    const { video, manifest } = await uploadedVideo();
    const complete = jest.spyOn(storage, 'completeMultipartUpload');
    manifest[1] = {
      ...manifest[1],
      etag: '"00000000000000000000000000000000"',
    };

    await expect(completion.complete(video, manifest)).rejects.toBeInstanceOf(
      UploadPartsMismatchException,
    );
    expect(complete).not.toHaveBeenCalled();
    expect((await row(video.id)).processing_status).toBe('uploading');
  });

  it('Gate 5: five concurrent completions → one transition, one job, no error', async () => {
    const { video, manifest } = await uploadedVideo();

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => completion.complete(video, manifest)),
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const outcomes = results.map(
      (r) => (r as PromiseFulfilledResult<{ outcome: string }>).value.outcome,
    );
    expect(outcomes.every((o) => o === 'done' || o === 'pending')).toBe(true);
    expect((await row(video.id)).processing_status).toBe('uploaded');
    expect(await jobsFor(video.id)).toHaveLength(1);
  });

  it('Gate 4: a lost Complete response keeps completing; the repeated complete proves the object and moves to uploaded', async () => {
    const { video, manifest } = await uploadedVideo();
    proxy.failNextComplete({ kind: 'drop-after-forward' });

    const first = await completion.complete(video, manifest);

    expect(first).toEqual({
      outcome: 'pending',
      processingStatus: 'completing',
    });
    expect(await jobsFor(video.id)).toHaveLength(0);
    const second = await completion.complete(await row(video.id), manifest);
    expect(second).toEqual({ outcome: 'done', processingStatus: 'uploaded' });
    expect(await jobsFor(video.id)).toHaveLength(1);
  });

  it('Gate 4: a reordered manifest is refused before any claim; a part replaced after its ETag was recorded is a mismatch', async () => {
    const { video, manifest } = await uploadedVideo();

    await expect(
      completion.complete(video, [manifest[1], manifest[0], manifest[2]]),
    ).rejects.toBeInstanceOf(ManifestInvalidException);
    await putPart(video, 2, randomBytes(5 * MIB)); // same number, new content
    await expect(completion.complete(video, manifest)).rejects.toBeInstanceOf(
      UploadPartsMismatchException,
    );
    expect((await row(video.id)).processing_status).toBe('uploading');
  });

  it('Gate 4: HTTP 200 with <Error>InternalError keeps completing (202); with <Error>InvalidPart returns to uploading (409)', async () => {
    const a = await uploadedVideo();
    proxy.failNextComplete({
      kind: 'error-200-no-forward',
      code: 'InternalError',
    });
    expect(await completion.complete(a.video, a.manifest)).toEqual({
      outcome: 'pending',
      processingStatus: 'completing',
    });
    expect((await row(a.video.id)).processing_status).toBe('completing');

    const b = await uploadedVideo();
    proxy.failNextComplete({
      kind: 'error-200-no-forward',
      code: 'InvalidPart',
    });
    await expect(
      completion.complete(b.video, b.manifest),
    ).rejects.toBeInstanceOf(UploadPartsMismatchException);
    expect((await row(b.video.id)).processing_status).toBe('uploading');
  });

  it('Gate 4: an object at the key with the declared size but another binding is refused as failed/UPLOAD_INVALID, with no job, and is NOT deleted automatically; with HeadObject unavailable it stays completing', async () => {
    const { video, manifest } = await uploadedVideo();
    proxy.failNextComplete({ kind: 'drop-after-forward' });
    await completion.complete(video, manifest); // completing, object created

    jest
      .spyOn(storage, 'headObject')
      .mockRejectedValueOnce(
        new StorageUnavailableError('ambiguous', 'TimeoutError', 'timed out'),
      );
    expect(await completion.complete(await row(video.id), manifest)).toEqual({
      outcome: 'pending',
      processingStatus: 'completing',
    });
    jest.restoreAllMocks();

    await dataSource.query(
      `UPDATE "videos" SET "upload_binding_token" = 'someone-else' WHERE id = $1`,
      [video.id],
    );
    const deleteObject = jest.spyOn(storage, 'deleteObject');
    const before = await storage.headObject(originalKey(video.id));

    await expect(
      completion.complete(await row(video.id), manifest),
    ).rejects.toBeInstanceOf(InvalidVideoStateException);

    const failed = await row(video.id);
    expect(failed.processing_status).toBe('failed');
    expect(failed.failure_reason).toBe('UPLOAD_INVALID');
    expect(await jobsFor(video.id)).toHaveLength(0);
    // Identity not proven → never deleted automatically; kept as evidence.
    expect(deleteObject).not.toHaveBeenCalled();
    const after = await storage.headObject(originalKey(video.id));
    expect(after).not.toBeNull();
    expect(after?.etag).toBe(before?.etag);
    // A repeated complete stays refused and still deletes nothing.
    await expect(
      completion.complete(await row(video.id), manifest),
    ).rejects.toBeInstanceOf(InvalidVideoStateException);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(await jobsFor(video.id)).toHaveLength(0);
  });

  it('a timeout or reset of Complete never returns the row to uploading nor marks it failed', async () => {
    const { video, manifest } = await uploadedVideo();
    proxy.failNextComplete({ kind: 'drop-after-forward' });

    await completion.complete(video, manifest);

    const current = await row(video.id);
    expect(current.processing_status).toBe('completing');
    expect(current.failure_reason).toBeNull();
  });

  it('answers STORAGE_UNAVAILABLE and keeps uploading when storage is unreachable before the claim', async () => {
    const { video, manifest } = await uploadedVideo();
    // A real storage endpoint that refuses connections (closed local port).
    const closed = await startS3FaultProxy(testStorageConfig().endpoint);
    const deadEndpoint = closed.endpoint;
    await closed.close();
    const config = { ...testStorageConfig(), endpoint: deadEndpoint };
    const dead = buildS3Clients(config);
    const deadStorage = new StorageService(dead, config);
    const offline = new VideoCompletionService(
      dataSource,
      deadStorage,
      new UploadRecoveryService(
        dataSource,
        deadStorage,
        app.get(JobPublisherService),
      ),
    );

    try {
      await expect(offline.complete(video, manifest)).rejects.toBeInstanceOf(
        StorageUnavailableException,
      );
    } finally {
      dead.internal.destroy();
      dead.singleAttempt.destroy();
      dead.publicSigner.destroy();
    }
    expect((await row(video.id)).processing_status).toBe('uploading');
  });
});
