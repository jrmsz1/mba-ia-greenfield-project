import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import uploadConfig from '../config/upload.config';
import { StorageError } from '../storage/storage-errors';
import { originalKey } from '../storage/storage-key';
import { StorageService } from '../storage/storage.service';
import { ABUSE_LIMITS } from './abuse-limits';
import { Video } from './entities/video.entity';
import {
  DeliveryUrlLimitExceededException,
  StorageUnavailableException,
  VideoNotReadyException,
} from './video.exceptions';
import { reserveWindowedCall } from './windowed-counter';

export interface DeliveryUrl {
  url: string;
  /** ISO-8601; the client renews before this instant. */
  expires_at: string;
}

/** RFC 5987 attr-char: everything else in the UTF-8 bytes is %-encoded. */
const encodeRfc5987 = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * `Content-Disposition: attachment` per RFC 6266: an ASCII `filename`
 * fallback (non-ASCII → `_`, quotes and backslashes escaped) plus the exact
 * UTF-8 name in `filename*`. The stored name is already sanitized at upload
 * start (paths and control characters stripped, TD-13).
 */
export function attachmentDisposition(filename: string): string {
  const ascii = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, (c) => `\\${c}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

/**
 * Presigned delivery for the owner of a `ready` video (phase-03-videos/TD-11,
 * revision IC-2; TD-12; TD-13). The URLs point at the PUBLIC storage
 * endpoint, so the bytes — including `Range` requests — never pass through
 * NestJS. Each emission reserves one slot of the shared one-hour window
 * (60 per video) BEFORE signing; the URL is never logged or persisted.
 */
@Injectable()
export class VideoDeliveryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    @Inject(uploadConfig.KEY)
    private readonly upload: ConfigType<typeof uploadConfig>,
  ) {}

  async playbackUrl(video: Video): Promise<DeliveryUrl> {
    return await this.issue(video, this.upload.playbackPresignTtlSeconds);
  }

  async downloadUrl(video: Video): Promise<DeliveryUrl> {
    return await this.issue(
      video,
      this.upload.downloadPresignTtlSeconds,
      attachmentDisposition(video.original_filename),
    );
  }

  private async issue(
    video: Video,
    ttlSeconds: number,
    contentDisposition?: string,
  ): Promise<DeliveryUrl> {
    if (video.processing_status !== 'ready') {
      throw new VideoNotReadyException();
    }
    const reserved = await reserveWindowedCall(
      this.dataSource.manager,
      video.id,
      'delivery',
      ABUSE_LIMITS.DELIVERY_URLS_PER_HOUR,
    );
    if (!reserved) {
      throw new DeliveryUrlLimitExceededException(
        ABUSE_LIMITS.DELIVERY_URLS_PER_HOUR,
      );
    }
    const issuedAt = Date.now();
    let url: string;
    try {
      url = await this.storage.presignGet(originalKey(video.id), ttlSeconds, {
        contentDisposition,
      });
    } catch (error) {
      if (error instanceof StorageError)
        throw new StorageUnavailableException();
      throw error;
    }
    return {
      url,
      expires_at: new Date(issuedAt + ttlSeconds * 1000).toISOString(),
    };
  }
}
