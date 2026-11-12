import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import uploadConfig from '../config/upload.config';
import { BucketBootstrapService } from '../storage/bucket-bootstrap.service';
import { buildS3Clients, type S3Clients } from '../storage/s3-clients.provider';
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
import { createTestOwner, type TestOwner } from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoUploadPartsService } from './video-upload-parts.service';
import { VideoUploadService } from './video-upload.service';

jest.setTimeout(60_000);

const ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MIB = 1024 * 1024;

describe('VideoUploadPartsService (real PostgreSQL + MinIO)', () => {
  let dataSource: DataSource;
  let clients: S3Clients;
  let storage: StorageService;
  let uploads: VideoUploadService;
  let parts: VideoUploadPartsService;
  let owner: TestOwner;

  beforeAll(async () => {
    dataSource = createTestDataSource(ENTITIES, { synchronize: false });
    await dataSource.initialize();
    const config = testStorageConfig();
    clients = buildS3Clients(config);
    storage = new StorageService(clients, config);
    await new BucketBootstrapService(clients, config).ensureBucket(
      config.bucket,
    );
    const upload = { ...uploadConfig(), partSizeBytes: 5 * MIB };
    uploads = new VideoUploadService(dataSource, storage, upload);
    parts = new VideoUploadPartsService(dataSource, storage, upload);
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
  });

  const startThreeParts = async (): Promise<Video> =>
    (
      await uploads.start(
        owner.user.id,
        `k-${randomBytes(4).toString('hex')}`,
        {
          filename: 'clip.mp4',
          sizeBytes: 12 * MIB,
        },
      )
    ).video;

  it('resumes from what storage holds after a partial upload', async () => {
    const video = await startThreeParts();
    const urls = await parts.issuePartUrls(video, [1, 3]);
    for (const { url, part_number } of urls) {
      const body =
        part_number === 3 ? randomBytes(2 * MIB) : randomBytes(5 * MIB);
      expect((await fetchPresigned(url, { method: 'PUT', body })).status).toBe(
        200,
      );
    }

    const status = await parts.getUploadStatus(video);

    expect(status.parts.map((p) => p.part_number)).toEqual([1, 3]);
    expect(status.parts.map((p) => p.size_bytes)).toEqual([5 * MIB, 2 * MIB]);
    expect(status.missing_part_numbers).toEqual([2]);
  });

  it('abort cancels the row and invalidates outstanding part URLs', async () => {
    const video = await startThreeParts();
    const [{ url }] = await parts.issuePartUrls(video, [2]);

    await parts.abort(video);

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(row.processing_status).toBe('cancelled');
    const put = await fetchPresigned(url, {
      method: 'PUT',
      body: randomBytes(5 * MIB),
    });
    expect(put.status).not.toBe(200);
  });
});
