import type { Video } from './entities/video.entity';
import {
  attachmentDisposition,
  VideoDeliveryService,
} from './video-delivery.service';
import {
  DeliveryUrlLimitExceededException,
  VideoNotReadyException,
} from './video.exceptions';

const VIDEO_ID = '6f1d1c2e-1b7a-4c3e-9d2a-1e0f5a4b3c2d';

function setup(reserved = true) {
  const dataSource = {
    manager: {
      query: jest
        .fn()
        .mockResolvedValue(reserved ? [[{ id: VIDEO_ID }], 1] : [[], 0]),
    },
  };
  const storage = {
    presignGet: jest
      .fn()
      .mockResolvedValue('http://localhost:9000/b/k?X-Amz-Signature=s'),
  };
  const service = new VideoDeliveryService(
    dataSource as never,
    storage as never,
    {
      playbackPresignTtlSeconds: 3600,
      downloadPresignTtlSeconds: 900,
    } as never,
  );
  const video = (status = 'ready'): Video =>
    ({
      id: VIDEO_ID,
      processing_status: status,
      original_filename: 'Meu vídeo.mp4',
    }) as Video;
  return { service, storage, dataSource, video };
}

describe('VideoDeliveryService', () => {
  afterEach(() => jest.useRealTimers());

  it('signs playback with PLAYBACK_PRESIGN_TTL_SECONDS on the original key and reports expires_at', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-12T12:00:00.000Z') });
    const t = setup();

    const result = await t.service.playbackUrl(t.video());

    expect(t.storage.presignGet).toHaveBeenCalledWith(
      `videos/${VIDEO_ID}/original`,
      3600,
      { contentDisposition: undefined },
    );
    expect(result.expires_at).toBe('2026-11-12T13:00:00.000Z');
  });

  it('signs download with DOWNLOAD_PRESIGN_TTL_SECONDS and an RFC 6266 attachment disposition', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-12T12:00:00.000Z') });
    const t = setup();

    const result = await t.service.downloadUrl(t.video());

    expect(t.storage.presignGet).toHaveBeenCalledWith(
      `videos/${VIDEO_ID}/original`,
      900,
      {
        contentDisposition:
          'attachment; filename="Meu v_deo.mp4"; filename*=UTF-8\'\'Meu%20v%C3%ADdeo.mp4',
      },
    );
    expect(result.expires_at).toBe('2026-11-12T12:15:00.000Z');
  });

  it.each(['uploading', 'completing', 'uploaded', 'processing', 'failed'])(
    'refuses a %s video with VIDEO_NOT_READY before reserving or signing',
    async (status) => {
      const t = setup();

      await expect(
        t.service.playbackUrl(t.video(status)),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
      expect(t.dataSource.manager.query).not.toHaveBeenCalled();
      expect(t.storage.presignGet).not.toHaveBeenCalled();
    },
  );

  it('refuses past the hourly cap with DELIVERY_URL_LIMIT_EXCEEDED and signs nothing', async () => {
    const t = setup(false);

    await expect(t.service.downloadUrl(t.video())).rejects.toBeInstanceOf(
      DeliveryUrlLimitExceededException,
    );
    expect(t.storage.presignGet).not.toHaveBeenCalled();
  });
});

describe('attachmentDisposition', () => {
  it('escapes quotes and backslashes in the ASCII fallback', () => {
    expect(attachmentDisposition('a"b\\c.mp4')).toBe(
      'attachment; filename="a\\"b\\\\c.mp4"; filename*=UTF-8\'\'a%22b%5Cc.mp4',
    );
  });

  it("percent-encodes RFC 5987 reserved characters (' ( ) *)", () => {
    expect(attachmentDisposition("it's (v1)*.mp4")).toContain(
      "filename*=UTF-8''it%27s%20%28v1%29%2A.mp4",
    );
  });
});
