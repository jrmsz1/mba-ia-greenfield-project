import type { ConfigType } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import type uploadConfig from '../config/upload.config';
import { StorageUnavailableError } from '../storage/storage-errors';
import type { StorageService } from '../storage/storage.service';
import type { Video } from './entities/video.entity';
import { VideoUploadPartsService } from './video-upload-parts.service';
import {
  InvalidVideoStateException,
  PartNumbersOutOfRangeException,
  PartUrlLimitExceededException,
  StorageUnavailableException,
  UploadControlRateExceededException,
  UploadExpiredException,
} from './video.exceptions';

const baseVideo = (overrides: Partial<Video> = {}): Video =>
  ({
    id: 'video-uuid',
    processing_status: 'uploading',
    upload_id: 'upload-1',
    expected_part_count: 3,
    part_size_bytes: 5,
    upload_expires_at: new Date(Date.now() + 60_000),
    ...overrides,
  }) as Video;

describe('VideoUploadPartsService', () => {
  let query: jest.Mock;
  let storage: jest.Mocked<
    Pick<StorageService, 'presignUploadPart' | 'listParts'>
  >;
  let service: VideoUploadPartsService;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([[{ id: 'video-uuid' }], 1]);
    storage = {
      presignUploadPart: jest.fn().mockResolvedValue('http://signed'),
      listParts: jest.fn().mockResolvedValue([]),
    };
    service = new VideoUploadPartsService(
      { query, manager: { query } } as unknown as DataSource,
      storage as unknown as StorageService,
      { partPresignTtlSeconds: 900 } as ConfigType<typeof uploadConfig>,
    );
  });

  describe('issuePartUrls', () => {
    it('should sign one URL per part with the part TTL', async () => {
      const urls = await service.issuePartUrls(baseVideo(), [1, 2]);

      expect(urls.map((u) => u.part_number)).toEqual([1, 2]);
      expect(storage.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-uuid/original',
        'upload-1',
        2,
        900,
      );
    });

    it.each([
      ['completing', InvalidVideoStateException],
      ['cancelled', InvalidVideoStateException],
    ] as const)('should refuse a %s video', async (status, error) => {
      await expect(
        service.issuePartUrls(baseVideo({ processing_status: status }), [1]),
      ).rejects.toBeInstanceOf(error);
    });

    it('should refuse an expired upload', async () => {
      await expect(
        service.issuePartUrls(
          baseVideo({ upload_expires_at: new Date(Date.now() - 1) }),
          [1],
        ),
      ).rejects.toBeInstanceOf(UploadExpiredException);
    });

    it('should refuse part numbers outside 1..expected_part_count', async () => {
      await expect(
        service.issuePartUrls(baseVideo(), [4]),
      ).rejects.toBeInstanceOf(PartNumbersOutOfRangeException);
      expect(query).not.toHaveBeenCalled();
    });

    it('should refuse when the issuance cap is reached, before signing', async () => {
      query.mockResolvedValueOnce([[], 0]);

      await expect(
        service.issuePartUrls(baseVideo(), [1]),
      ).rejects.toBeInstanceOf(PartUrlLimitExceededException);
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });
  });

  describe('getUploadStatus', () => {
    it('should report the stored parts and the missing numbers', async () => {
      storage.listParts.mockResolvedValue([
        { partNumber: 1, sizeBytes: 5, etag: '"a"' },
        { partNumber: 3, sizeBytes: 2, etag: '"c"' },
      ]);

      const status = await service.getUploadStatus(baseVideo());

      expect(status.missing_part_numbers).toEqual([2]);
      expect(status.parts).toEqual([
        { part_number: 1, size_bytes: 5, etag: '"a"' },
        { part_number: 3, size_bytes: 2, etag: '"c"' },
      ]);
    });

    it('should refuse a terminal video', async () => {
      await expect(
        service.getUploadStatus(baseVideo({ processing_status: 'ready' })),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);
    });

    it('should stop at the control-rate limit without calling storage', async () => {
      query.mockResolvedValueOnce([[], 0]);

      await expect(service.getUploadStatus(baseVideo())).rejects.toBeInstanceOf(
        UploadControlRateExceededException,
      );
      expect(storage.listParts).not.toHaveBeenCalled();
    });

    it('should answer STORAGE_UNAVAILABLE when ListParts fails', async () => {
      storage.listParts.mockRejectedValue(
        new StorageUnavailableError('transient', 'ECONNREFUSED', 'down'),
      );

      await expect(service.getUploadStatus(baseVideo())).rejects.toBeInstanceOf(
        StorageUnavailableException,
      );
    });
  });

  describe('abort', () => {
    it('should be a no-op for an already cancelled video', async () => {
      await expect(
        service.abort(baseVideo({ processing_status: 'cancelled' })),
      ).resolves.toBeUndefined();
      expect(query).not.toHaveBeenCalled();
    });

    it('should refuse a completing video', async () => {
      await expect(
        service.abort(baseVideo({ processing_status: 'completing' })),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);
    });
  });
});
