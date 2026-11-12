import type { ConfigType } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import uploadConfig from '../config/upload.config';
import {
  buildS3Clients,
  destroyS3Clients,
  type S3Clients,
} from '../storage/s3-clients.provider';
import {
  StorageRejectedError,
  StorageUnavailableError,
} from '../storage/storage-errors';
import { originalKey } from '../storage/storage-key';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { verifyTestBucket, testStorageConfig } from '../test/test-storage';
import { createTestOwner, type TestOwner } from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { sessionLockOps } from './video-session-lock';
import { VideoUploadService } from './video-upload.service';
import {
  ActiveUploadLimitExceededException,
  IdempotencyKeyConflictException,
  PendingUploadQuotaExceededException,
  StorageUnavailableException,
  UploadStartInProgressException,
  UploadStartRateExceededException,
} from './video.exceptions';

jest.setTimeout(60_000);

const ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

type UploadConfig = ConfigType<typeof uploadConfig>;

describe('VideoUploadService.start (real PostgreSQL + MinIO)', () => {
  let dataSource: DataSource;
  let clients: S3Clients;
  let storage: StorageService;
  let owner: TestOwner;

  const service = (overrides: Partial<UploadConfig> = {}) =>
    new VideoUploadService(dataSource, storage, {
      ...uploadConfig(),
      partSizeBytes: 5 * MIB,
      ...overrides,
    });

  const start = (svc: VideoUploadService, key: string, sizeBytes = 12 * MIB) =>
    svc.start(owner.user.id, key, { filename: 'clip.mp4', sizeBytes });

  /** The real method, captured before any spy replaces it. */
  const realCreate = (): StorageService['createMultipartUpload'] =>
    storage.createMultipartUpload.bind(
      storage,
    ) as StorageService['createMultipartUpload'];

  const openSessions = async (video: Video) =>
    await storage.listMultipartUploads(originalKey(video.id));

  beforeAll(async () => {
    dataSource = createTestDataSource(ENTITIES, { synchronize: false });
    await dataSource.initialize();
    const config = testStorageConfig();
    clients = buildS3Clients(config);
    storage = new StorageService(clients, config);
    await verifyTestBucket(clients.internal, config.bucket);
  });

  afterAll(async () => {
    await dataSource.destroy();
    destroyS3Clients(clients);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanAllTables(dataSource);
    owner = await createTestOwner(dataSource);
  });

  it('creates a private draft in uploading with an upload id, part plan and future expiry', async () => {
    const { video, created } = await start(service(), 'k-1');

    expect(created).toBe(true);
    expect(video).toMatchObject({
      processing_status: 'uploading',
      publication: 'draft',
      expected_part_count: 3,
      part_size_bytes: 5 * MIB,
      declared_size_bytes: 12 * MIB,
    });
    expect(video.upload_id).toEqual(expect.any(String));
    expect(video.public_id).toMatch(/^[0-9A-Za-z]{11}$/);
    expect(video.upload_expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(await openSessions(video)).toEqual([video.upload_id]);
  });

  it('replays the same key and payload as the same video and upload', async () => {
    const svc = service();
    const first = await start(svc, 'k-2');
    const second = await start(svc, 'k-2');

    expect(second.created).toBe(false);
    expect(second.video.public_id).toBe(first.video.public_id);
    expect(second.video.upload_id).toBe(first.video.upload_id);
    expect(await openSessions(first.video)).toHaveLength(1);
    await expect(
      svc.start(owner.user.id, 'k-2', {
        filename: 'clip.mp4',
        sizeBytes: 13 * MIB,
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictException);
  });

  it('rejects a start over the active-upload limit and serializes concurrent starts of one owner', async () => {
    const svc = service({ maxActiveUploadsPerOwner: 1 });
    await start(svc, 'k-open');
    const spy = jest.spyOn(storage, 'createMultipartUpload');

    await expect(start(svc, 'k-next')).rejects.toBeInstanceOf(
      ActiveUploadLimitExceededException,
    );
    expect(spy).not.toHaveBeenCalled();

    // (i) concurrent starts with capacity for exactly one
    await cleanAllTables(dataSource);
    owner = await createTestOwner(dataSource);
    const results = await Promise.allSettled([
      start(svc, 'k-a'),
      start(svc, 'k-b'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ActiveUploadLimitExceededException);
    expect(await dataSource.getRepository(Video).count()).toBe(1);
  });

  it('rejects concurrent starts that exceed the pending-bytes quota, and admits both with the defaults', async () => {
    // (ii) capacity equal to one request
    const tight = service({
      maxActiveUploadsPerOwner: 3,
      maxPendingUploadBytesPerOwner: 12 * MIB,
    });
    const results = await Promise.allSettled([
      start(tight, 'q-a'),
      start(tight, 'q-b'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')?.reason).toBeInstanceOf(
      PendingUploadQuotaExceededException,
    );

    // defaults (3 active, 20 GiB): two 10 GiB requests are both admitted
    await cleanAllTables(dataSource);
    owner = await createTestOwner(dataSource);
    const defaults = service({ partSizeBytes: 64 * MIB });
    const both = await Promise.allSettled([
      start(defaults, 'd-a', 10 * GIB),
      start(defaults, 'd-b', 10 * GIB),
    ]);
    expect(both.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('releases pending bytes once an upload leaves uploading/completing', async () => {
    const svc = service({ maxPendingUploadBytesPerOwner: 12 * MIB });
    const { video } = await start(svc, 'p-1');
    await expect(start(svc, 'p-2')).rejects.toBeInstanceOf(
      PendingUploadQuotaExceededException,
    );

    await dataSource
      .getRepository(Video)
      .update({ id: video.id }, { processing_status: 'uploaded' });

    await expect(start(svc, 'p-2')).resolves.toMatchObject({ created: true });
  });

  it('stores a sanitized filename', async () => {
    const { video } = await service().start(owner.user.id, 'f-1', {
      filename: '../../etc/passwd\u0007.mp4',
      sizeBytes: 6 * MIB,
    });

    expect(video.original_filename).toBe('passwd.mp4');
  });

  it('deletes the reservation on a definitive CreateMultipartUpload rejection', async () => {
    jest
      .spyOn(storage, 'createMultipartUpload')
      .mockRejectedValueOnce(
        new StorageRejectedError('definitive', 'AccessDenied', 'denied'),
      );
    const svc = service({ maxActiveUploadsPerOwner: 1 });

    await expect(start(svc, 'r-1')).rejects.toBeInstanceOf(
      StorageUnavailableException,
    );
    expect(await dataSource.getRepository(Video).count()).toBe(0);
    await expect(start(svc, 'r-2')).resolves.toMatchObject({ created: true });
  });

  it('keeps the reservation when the create response is lost, and the retry ends with one session', async () => {
    const real = realCreate();
    jest
      .spyOn(storage, 'createMultipartUpload')
      .mockImplementationOnce(
        async (key: string, token: string, contentType?: string) => {
          await real(key, token, contentType); // the session IS created...
          throw new StorageUnavailableError(
            'ambiguous',
            'TimeoutError',
            'lost',
          );
        },
      );
    const svc = service({ maxActiveUploadsPerOwner: 1 });

    await expect(start(svc, 'l-1')).rejects.toBeInstanceOf(
      StorageUnavailableException,
    );
    const reservation = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ idempotency_key: 'l-1' });
    expect(reservation.upload_id).toBeNull();
    expect(reservation.multipart_create_attempted_at).not.toBeNull();
    await expect(start(svc, 'l-other')).rejects.toBeInstanceOf(
      ActiveUploadLimitExceededException,
    );

    const retried = await start(svc, 'l-1');

    expect(retried.video.upload_id).toEqual(expect.any(String));
    expect(await openSessions(retried.video)).toEqual([
      retried.video.upload_id,
    ]);
  });

  it('lets only one of three concurrent retries create the session; the others get UPLOAD_START_IN_PROGRESS at once', async () => {
    const real = realCreate();
    const spy = jest
      .spyOn(storage, 'createMultipartUpload')
      .mockImplementationOnce(
        async (key: string, token: string, contentType?: string) => {
          await real(key, token, contentType);
          throw new StorageUnavailableError(
            'ambiguous',
            'TimeoutError',
            'lost',
          );
        },
      );
    const svc = service();
    await expect(start(svc, 'c-1')).rejects.toBeInstanceOf(
      StorageUnavailableException,
    );
    spy.mockImplementation(
      async (key: string, token: string, contentType?: string) => {
        await new Promise((resolve) => setTimeout(resolve, 500)); // hold the lock
        return await real(key, token, contentType);
      },
    );

    const startedAt = Date.now();
    const results = await Promise.allSettled([
      start(svc, 'c-1'),
      start(svc, 'c-1'),
      start(svc, 'c-1'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    for (const loser of losers) {
      expect(loser.reason).toBeInstanceOf(UploadStartInProgressException);
    }
    const video = (fulfilled[0] as PromiseFulfilledResult<{ video: Video }>)
      .value.video;
    expect(await openSessions(video)).toEqual([video.upload_id]);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('keeps the reservation and creates nothing when storage is unreachable during the investigation', async () => {
    const real = realCreate();
    const create = jest
      .spyOn(storage, 'createMultipartUpload')
      .mockImplementationOnce(
        async (key: string, token: string, contentType?: string) => {
          await real(key, token, contentType);
          throw new StorageUnavailableError(
            'ambiguous',
            'TimeoutError',
            'lost',
          );
        },
      );
    const svc = service();
    await expect(start(svc, 'u-1')).rejects.toBeInstanceOf(
      StorageUnavailableException,
    );
    jest
      .spyOn(storage, 'listMultipartUploads')
      .mockRejectedValue(
        new StorageUnavailableError('transient', 'ECONNREFUSED', 'down'),
      );
    create.mockClear();

    await expect(start(svc, 'u-1')).rejects.toBeInstanceOf(
      StorageUnavailableException,
    );
    expect(create).not.toHaveBeenCalled();
    const reservation = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ idempotency_key: 'u-1' });
    expect(reservation.upload_id).toBeNull();
  });

  it('rejects the 21st start of a channel within one hour without reserving', async () => {
    const svc = service({
      maxActiveUploadsPerOwner: 100,
      maxPendingUploadBytesPerOwner: 100 * GIB,
    });
    for (let i = 0; i < 20; i++) {
      await start(svc, `rate-${i}`, 6 * MIB);
    }

    await expect(start(svc, 'rate-20', 6 * MIB)).rejects.toBeInstanceOf(
      UploadStartRateExceededException,
    );
    expect(await dataSource.getRepository(Video).count()).toBe(20);
  });

  it('discards the connection when the advisory unlock is not confirmed, and the next start gets the lock', async () => {
    const real = realCreate();
    jest
      .spyOn(storage, 'createMultipartUpload')
      .mockImplementationOnce(
        async (key: string, token: string, contentType?: string) => {
          await real(key, token, contentType);
          throw new StorageUnavailableError(
            'ambiguous',
            'TimeoutError',
            'lost',
          );
        },
      );
    const svc = service();
    const unlock = jest
      .spyOn(sessionLockOps, 'unlock')
      .mockResolvedValueOnce(false);

    await expect(start(svc, 'x-1')).rejects.toBeInstanceOf(
      StorageUnavailableException,
    );
    expect(unlock).toHaveBeenCalledTimes(1);

    // The discarded connection released the session lock: the retry proceeds.
    const retried = await start(svc, 'x-1');
    expect(retried.video.upload_id).toEqual(expect.any(String));
  });
});
