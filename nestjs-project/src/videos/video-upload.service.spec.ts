import type { DataSource } from 'typeorm';
import type { StorageService } from '../storage/storage.service';
import { VideoUploadService } from './video-upload.service';
import { UploadSizeExceededException } from './video.exceptions';

describe('VideoUploadService', () => {
  it('should reject a size above MAX_UPLOAD_BYTES before touching the database or storage', async () => {
    const dataSource = { transaction: jest.fn(), createQueryRunner: jest.fn() };
    const storage = { createMultipartUpload: jest.fn() };
    const service = new VideoUploadService(
      dataSource as unknown as DataSource,
      storage as unknown as StorageService,
      {
        maxUploadBytes: 100,
        partSizeBytes: 10,
        expiryHours: 24,
        partPresignTtlSeconds: 900,
        playbackPresignTtlSeconds: 3600,
        downloadPresignTtlSeconds: 900,
        completingStaleMinutes: 15,
        maxActiveUploadsPerOwner: 3,
        maxPendingUploadBytesPerOwner: 1000,
      },
    );

    await expect(
      service.start('user-1', 'key-1', { filename: 'a.mp4', sizeBytes: 101 }),
    ).rejects.toBeInstanceOf(UploadSizeExceededException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });
});
