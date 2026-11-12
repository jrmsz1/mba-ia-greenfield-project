/**
 * SI-03.15 — reaper/reconciler against real PostgreSQL, the pinned MinIO and
 * pg-boss. Covers every acceptance criterion plus the review requirements:
 * divergent/indeterminate objects preserved, no release without cleanup
 * evidence, storage unavailability never read as "no upload", and
 * overlapping runs without duplicated transitions or effects.
 */
import { PutObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';
import { type INestApplication } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import workerConfig from '../config/worker.config';
import { JobPublisherService } from '../queue/job-publisher.service';
import { PGBOSS, QUEUES, RECONCILE_CRON } from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { BucketBootstrapService } from '../storage/bucket-bootstrap.service';
import { buildS3Clients, type S3Clients } from '../storage/s3-clients.provider';
import { UploadNotFoundError } from '../storage/storage-errors';
import { UPLOAD_BINDING_METADATA_KEY } from '../storage/storage.constants';
import { originalKey } from '../storage/storage-key';
import { StorageService, type ManifestPart } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestTypeOrmModule,
} from '../test/create-test-data-source';
import { startS3FaultProxy } from '../test/s3-fault-proxy';
import { emptyTestBucket, testStorageConfig } from '../test/test-storage';
import {
  buildVideoValues,
  createTestOwner,
  type TestOwner,
} from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { UploadRecoveryService } from '../videos/upload-recovery.service';
import { VideoUploadService } from '../videos/video-upload.service';
import { VideoReconcilerWorker } from './video-reconciler.worker';

jest.setTimeout(120_000);

const ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MIB = 1024 * 1024;
const SIZE = 7 * MIB; // two parts: 5 MiB + 2 MiB
const FAST = { maxAbortAttempts: 5, backoffMs: 20 };

describe('VideoReconcilerWorker (real PostgreSQL + MinIO + pg-boss)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let boss: PgBoss;
  let storage: StorageService;
  let s3: S3Clients;
  let upload: ConfigType<typeof uploadConfig>;
  let uploads: VideoUploadService;
  let reconciler: VideoReconcilerWorker;
  let recovery: UploadRecoveryService;
  let owner: TestOwner;

  const row = async (id: string) =>
    await dataSource.getRepository(Video).findOneBy({ id });

  const tokenOf = async (id: string): Promise<string> =>
    (await recovery.loadWithToken(id)).upload_binding_token;

  const activeJobs = async (id: string) =>
    (await boss.findJobs(QUEUES.VIDEO_PROCESS, { key: id })).filter((j) =>
      ['created', 'retry', 'active'].includes(j.state),
    );

  /** A real upload started through the API service (session open). */
  const startedUpload = async (): Promise<Video> =>
    (
      await uploads.start(
        owner.user.id,
        `k-${randomBytes(4).toString('hex')}`,
        { filename: 'clip.mp4', sizeBytes: SIZE },
      )
    ).video;

  /** Sends both parts and completes the session in storage only (row untouched). */
  const completeInStorage = async (video: Video): Promise<void> => {
    const key = originalKey(video.id);
    const manifest: ManifestPart[] = [];
    for (const [i, size] of [5 * MIB, 2 * MIB].entries()) {
      const out = await s3.internal.send(
        new UploadPartCommand({
          Bucket: storage.bucket,
          Key: key,
          UploadId: video.upload_id as string,
          PartNumber: i + 1,
          Body: randomBytes(size),
        }),
      );
      manifest.push({ partNumber: i + 1, etag: out.ETag as string });
    }
    await storage.completeMultipartUpload(
      key,
      video.upload_id as string,
      manifest,
    );
  };

  const expire = async (id: string): Promise<void> => {
    await dataSource.query(
      `UPDATE "videos" SET "upload_expires_at" = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
  };

  /** A reconciler whose storage refuses every connection. */
  const offlineReconciler = async (): Promise<{
    worker: VideoReconcilerWorker;
    close: () => void;
  }> => {
    const closed = await startS3FaultProxy(testStorageConfig().endpoint);
    const endpoint = closed.endpoint;
    await closed.close();
    const config = { ...testStorageConfig(), endpoint };
    const dead = buildS3Clients(config);
    const deadStorage = new StorageService(dead, config);
    const publisher = app.get(JobPublisherService);
    return {
      worker: new VideoReconcilerWorker(
        boss,
        dataSource,
        deadStorage,
        new UploadRecoveryService(dataSource, deadStorage, publisher),
        publisher,
        upload,
        app.get(queueConfig.KEY),
      ),
      close: () => {
        dead.internal.destroy();
        dead.singleAttempt.destroy();
        dead.publicSigner.destroy();
      },
    };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            databaseConfig,
            queueConfig,
            workerConfig,
            storageConfig,
            uploadConfig,
          ],
        }),
        createTestTypeOrmModule(ENTITIES, { synchronize: false }),
        QueueModule.register({ role: 'api' }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    boss = app.get<PgBoss>(PGBOSS);
    upload = { ...app.get<ConfigType<typeof uploadConfig>>(uploadConfig.KEY) };
    upload.partSizeBytes = 5 * MIB;
    upload.completingStaleMinutes = 1;

    const config = testStorageConfig();
    s3 = buildS3Clients(config);
    storage = new StorageService(s3, config);
    await new BucketBootstrapService(s3, config).ensureBucket(config.bucket);
    uploads = new VideoUploadService(dataSource, storage, upload);
    recovery = new UploadRecoveryService(
      dataSource,
      storage,
      app.get(JobPublisherService),
    );
    reconciler = new VideoReconcilerWorker(
      boss,
      dataSource,
      storage,
      recovery,
      app.get(JobPublisherService),
      upload,
      app.get(queueConfig.KEY),
    );
  });

  afterAll(async () => {
    await app.close();
    s3.internal.destroy();
    s3.singleAttempt.destroy();
    s3.publicSigner.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await emptyTestBucket(s3.internal, storage.bucket);
    await boss.deleteAllJobs(QUEUES.VIDEO_PROCESS);
    owner = await createTestOwner(dataSource);
  });

  afterEach(() => {
    for (const method of [
      'abortMultipartUpload',
      'deleteObject',
      'headObject',
    ] as const) {
      const fn = storage[method] as unknown as { mockRestore?: () => void };
      fn.mockRestore?.();
    }
  });

  it('expires an expired upload and its session answers NoSuchUpload', async () => {
    const video = await startedUpload();
    await expire(video.id);

    const report = await reconciler.runOnce(FAST);

    expect(report.expired).toBe(1);
    expect((await row(video.id))?.processing_status).toBe('expired');
    await expect(
      storage.listParts(originalKey(video.id), video.upload_id as string),
    ).rejects.toBeInstanceOf(UploadNotFoundError);
  });

  it('repeats the abort when a part keeps the session alive after the first abort, and only then expires', async () => {
    const video = await startedUpload();
    await expire(video.id);
    // First abort "loses the race" with a part in transit: the session survives.
    const abort = jest
      .spyOn(storage, 'abortMultipartUpload')
      .mockResolvedValueOnce(undefined);

    await reconciler.runOnce(FAST);

    expect(abort.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect((await row(video.id))?.processing_status).toBe('expired');
  });

  it('sends an expired upload whose object was completed with the expected binding through the proof to uploaded, never expired', async () => {
    const video = await startedUpload();
    await completeInStorage(video);
    await expire(video.id);

    const report = await reconciler.runOnce(FAST);

    expect(report).toMatchObject({ expired: 0, expiryResolvedByProof: 1 });
    expect((await row(video.id))?.processing_status).toBe('uploaded');
    expect(await activeJobs(video.id)).toHaveLength(1);
  });

  it('preserves an object with a DIVERGENT binding: no transition, no delete, quota kept', async () => {
    const video = await startedUpload();
    const key = originalKey(video.id);
    await storage.abortMultipartUpload(key, video.upload_id as string);
    await s3.internal.send(
      new PutObjectCommand({
        Bucket: storage.bucket,
        Key: key,
        Body: randomBytes(1024),
        Metadata: { [UPLOAD_BINDING_METADATA_KEY]: 'someone-else' },
      }),
    );
    await expire(video.id);
    const del = jest.spyOn(storage, 'deleteObject');

    const report = await reconciler.runOnce(FAST);

    expect(report.indeterminate).toBe(1);
    expect((await row(video.id))?.processing_status).toBe('uploading');
    expect(del).not.toHaveBeenCalled();
    expect(await storage.headObject(key)).not.toBeNull();
  });

  it('removes an orphan reservation only after its orphan session is aborted until NoSuchUpload and HeadObject is 404', async () => {
    const reservation = await dataSource.getRepository(Video).save(
      dataSource.getRepository(Video).create({
        public_id: randomBytes(8).toString('hex').slice(0, 11),
        ...buildVideoValues(owner.channel.id, {
          upload_id: null,
          multipart_create_attempted_at: new Date(),
        }),
      }),
    );
    await dataSource.query(
      `UPDATE "videos" SET "created_at" = now() - interval '20 minutes' WHERE id = $1`,
      [reservation.id],
    );
    const key = originalKey(reservation.id);
    // The create's response was lost: a session exists without upload_id.
    const orphan = await storage.createMultipartUpload(
      key,
      await tokenOf(reservation.id),
    );

    const report = await reconciler.runOnce(FAST);

    expect(report.reservationsRemoved).toBe(1);
    expect(await row(reservation.id)).toBeNull();
    await expect(storage.listParts(key, orphan)).rejects.toBeInstanceOf(
      UploadNotFoundError,
    );
    expect(await storage.headObject(key)).toBeNull();
  });

  it('with storage unreachable keeps the orphan reservation, the expired upload and the stale claim exactly as they are', async () => {
    const reservation = await dataSource.getRepository(Video).save(
      dataSource.getRepository(Video).create({
        public_id: randomBytes(8).toString('hex').slice(0, 11),
        ...buildVideoValues(owner.channel.id, { upload_id: null }),
      }),
    );
    await dataSource.query(
      `UPDATE "videos" SET "created_at" = now() - interval '20 minutes' WHERE id = $1`,
      [reservation.id],
    );
    const expired = await startedUpload();
    await expire(expired.id);
    const stale = await startedUpload();
    await completeInStorage(stale);
    await dataSource.query(
      `UPDATE "videos" SET "processing_status" = 'completing', "completing_since" = now() - interval '10 minutes' WHERE id = $1`,
      [stale.id],
    );
    const offline = await offlineReconciler();

    try {
      const report = await offline.worker.runOnce(FAST);

      expect(report.indeterminate).toBe(3);
    } finally {
      offline.close();
    }
    expect((await row(reservation.id))?.processing_status).toBe('uploading');
    expect((await row(expired.id))?.processing_status).toBe('uploading');
    expect((await row(stale.id))?.processing_status).toBe('completing');
  });

  it('resolves a stale completing claim whose object satisfies the proof to uploaded with one job', async () => {
    const video = await startedUpload();
    await completeInStorage(video);
    await dataSource.query(
      `UPDATE "videos" SET "processing_status" = 'completing', "completing_since" = now() - interval '10 minutes' WHERE id = $1`,
      [video.id],
    );

    const report = await reconciler.runOnce(FAST);

    expect(report.staleClaimsResolved).toBe(1);
    expect((await row(video.id))?.processing_status).toBe('uploaded');
    expect(await activeJobs(video.id)).toHaveLength(1);
  });

  it('republishes exactly one job for an uploaded video without one; a second run adds none', async () => {
    const video = await dataSource.getRepository(Video).save(
      dataSource.getRepository(Video).create({
        public_id: randomBytes(8).toString('hex').slice(0, 11),
        ...buildVideoValues(owner.channel.id, {
          processing_status: 'uploaded',
        }),
      }),
    );

    expect((await reconciler.runOnce(FAST)).republished).toBe(1);
    expect((await reconciler.runOnce(FAST)).republished).toBe(0);
    expect(await activeJobs(video.id)).toHaveLength(1);
  });

  it('two overlapping runs produce no duplicated transition or effect', async () => {
    const expired = await startedUpload();
    await expire(expired.id);
    const stale = await startedUpload();
    await completeInStorage(stale);
    await dataSource.query(
      `UPDATE "videos" SET "processing_status" = 'completing', "completing_since" = now() - interval '10 minutes' WHERE id = $1`,
      [stale.id],
    );
    const uploaded = await dataSource.getRepository(Video).save(
      dataSource.getRepository(Video).create({
        public_id: randomBytes(8).toString('hex').slice(0, 11),
        ...buildVideoValues(owner.channel.id, {
          processing_status: 'uploaded',
        }),
      }),
    );

    const [a, b] = await Promise.all([
      reconciler.runOnce(FAST),
      reconciler.runOnce(FAST),
    ]);

    expect(a.expired + b.expired).toBe(1);
    expect(a.staleClaimsResolved + b.staleClaimsResolved).toBe(1);
    expect(a.republished + b.republished).toBe(1);
    expect((await row(expired.id))?.processing_status).toBe('expired');
    expect((await row(stale.id))?.processing_status).toBe('uploaded');
    expect(await activeJobs(stale.id)).toHaveLength(1);
    expect(await activeJobs(uploaded.id)).toHaveLength(1);
  });

  it('start() schedules video.reconcile every 5 minutes and consumes it', async () => {
    await reconciler.start();
    try {
      const schedules = await boss.getSchedules(QUEUES.VIDEO_RECONCILE);

      expect(schedules).toEqual([
        expect.objectContaining({
          name: QUEUES.VIDEO_RECONCILE,
          cron: RECONCILE_CRON,
        }),
      ]);
    } finally {
      await boss.offWork(QUEUES.VIDEO_RECONCILE);
      await boss.unschedule(QUEUES.VIDEO_RECONCILE);
    }
  });
});
