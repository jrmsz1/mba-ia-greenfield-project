/**
 * SI-03.10 — evidence-based resolution branches not reached through
 * `complete` (expired, lost upload, reconciler release, ambiguous storage).
 */
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
import { StorageUnavailableError } from '../storage/storage-errors';
import { originalKey } from '../storage/storage-key';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestTypeOrmModule,
} from '../test/create-test-data-source';
import { emptyTestBucket, testStorageConfig } from '../test/test-storage';
import { createTestOwner, type TestOwner } from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { UploadRecoveryService } from './upload-recovery.service';
import { VideoUploadService } from './video-upload.service';

jest.setTimeout(60_000);

const ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MIB = 1024 * 1024;

describe('UploadRecoveryService (real PostgreSQL + MinIO)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let boss: PgBoss;
  let clients: S3Clients;
  let storage: StorageService;
  let uploads: VideoUploadService;
  let recovery: UploadRecoveryService;
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
    clients = buildS3Clients(config);
    storage = new StorageService(clients, config);
    await new BucketBootstrapService(clients, config).ensureBucket(
      config.bucket,
    );
    uploads = new VideoUploadService(dataSource, storage, {
      ...uploadConfig(),
      partSizeBytes: 5 * MIB,
    });
    recovery = new UploadRecoveryService(
      dataSource,
      storage,
      app.get(JobPublisherService),
    );
  });

  afterAll(async () => {
    await app.close();
    clients.internal.destroy();
    clients.singleAttempt.destroy();
    clients.publicSigner.destroy();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanAllTables(dataSource);
    await emptyTestBucket(clients.internal, storage.bucket);
    await boss.deleteAllJobs(QUEUES.VIDEO_PROCESS);
    owner = await createTestOwner(dataSource);
  });

  const started = async (): Promise<Video> =>
    (
      await uploads.start(
        owner.user.id,
        `k-${randomBytes(4).toString('hex')}`,
        { filename: 'clip.mp4', sizeBytes: 12 * MIB },
      )
    ).video;

  const setStatus = async (id: string, status: string): Promise<void> => {
    await dataSource.query(
      `UPDATE "videos" SET "processing_status" = $2 WHERE id = $1`,
      [id, status],
    );
  };

  const row = async (id: string) =>
    await dataSource.getRepository(Video).findOneByOrFail({ id });

  it('marks failed/UPLOAD_LOST when the upload session is gone and no object exists', async () => {
    const video = await started();
    await setStatus(video.id, 'completing');
    await storage.abortMultipartUpload(
      originalKey(video.id),
      video.upload_id as string,
    );

    expect(await recovery.resolve(video.id)).toBe('failed');
    expect(await row(video.id)).toMatchObject({
      processing_status: 'failed',
      failure_reason: 'UPLOAD_LOST',
    });
  });

  it('marks expired when the session is gone, no object exists and the upload expired', async () => {
    const video = await started();
    await dataSource.query(
      `UPDATE "videos" SET "upload_expires_at" = now() - interval '1 minute' WHERE id = $1`,
      [video.id],
    );
    await storage.abortMultipartUpload(
      originalKey(video.id),
      video.upload_id as string,
    );

    expect(await recovery.resolve(video.id)).toBe('expired');
    expect((await row(video.id)).processing_status).toBe('expired');
  });

  it('keeps a completing row when the session is still open and release is not requested', async () => {
    const video = await started();
    await setStatus(video.id, 'completing');

    expect(await recovery.resolve(video.id)).toBe('pending');
    expect((await row(video.id)).processing_status).toBe('completing');
  });

  it('releases a completing claim back to uploading only when release is requested', async () => {
    const video = await started();
    await setStatus(video.id, 'completing');

    expect(await recovery.resolve(video.id, { allowRelease: true })).toBe(
      'released',
    );
    expect((await row(video.id)).processing_status).toBe('uploading');
  });

  it('changes nothing when storage answers ambiguously', async () => {
    const video = await started();
    await setStatus(video.id, 'completing');
    jest
      .spyOn(storage, 'listParts')
      .mockRejectedValueOnce(
        new StorageUnavailableError('ambiguous', 'ECONNRESET', 'reset'),
      );

    expect(await recovery.resolve(video.id, { allowRelease: true })).toBe(
      'pending',
    );
    expect((await row(video.id)).processing_status).toBe('completing');
  });

  it('ignores rows outside uploading/completing', async () => {
    const video = await started();
    await setStatus(video.id, 'cancelled');

    expect(await recovery.resolve(video.id)).toBe('pending');
    expect((await row(video.id)).processing_status).toBe('cancelled');
  });
});
