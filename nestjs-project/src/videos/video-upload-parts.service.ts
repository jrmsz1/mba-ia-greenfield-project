import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import uploadConfig from '../config/upload.config';
import { confirmUploadsGone } from '../storage/multipart-cleanup';
import { StorageError } from '../storage/storage-errors';
import { originalKey } from '../storage/storage-key';
import { StorageService, type StoredPart } from '../storage/storage.service';
import { ABUSE_LIMITS } from './abuse-limits';
import { Video } from './entities/video.entity';
import {
  InvalidVideoStateException,
  PartNumbersOutOfRangeException,
  PartUrlLimitExceededException,
  StorageUnavailableException,
  UploadControlRateExceededException,
  UploadExpiredException,
} from './video.exceptions';
import { firstRows, reserveWindowedCall } from './windowed-counter';

export interface IssuedPartUrl {
  part_number: number;
  url: string;
  expires_at: string;
}

export interface UploadStatus {
  processing_status: string;
  part_size_bytes: number;
  expected_part_count: number;
  upload_expires_at: string;
  parts: { part_number: number; size_bytes: number; etag: string }[];
  missing_part_numbers: number[];
}

/**
 * Operations on an upload in progress: re-requestable part URLs, resume from
 * what storage already holds, and cancellation with confirmed cleanup
 * (phase-03-videos/TD-01, TD-02, TD-09, TD-13, TD-14; plan SI-03.9).
 */
@Injectable()
export class VideoUploadPartsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    @Inject(uploadConfig.KEY)
    private readonly upload: ConfigType<typeof uploadConfig>,
  ) {}

  async issuePartUrls(
    video: Video,
    partNumbers: number[],
  ): Promise<IssuedPartUrl[]> {
    this.assertUploading(video);
    const outOfRange = partNumbers.filter(
      (n) => n < 1 || n > video.expected_part_count,
    );
    if (outOfRange.length > 0) {
      throw new PartNumbersOutOfRangeException(video.expected_part_count);
    }

    const limit = ABUSE_LIMITS.PART_URL_FACTOR * video.expected_part_count;
    const reserved: unknown[] = await this.dataSource.query(
      `UPDATE "videos" SET "part_urls_issued" = "part_urls_issued" + $2
       WHERE id = $1 AND "part_urls_issued" + $2 <= $3
       RETURNING id`,
      [video.id, partNumbers.length, limit],
    );
    if (firstRows(reserved).length === 0) {
      throw new PartUrlLimitExceededException(limit);
    }

    const ttl = this.upload.partPresignTtlSeconds;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const key = originalKey(video.id);
    return await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storage.presignUploadPart(
          key,
          video.upload_id as string,
          partNumber,
          ttl,
        ),
        expires_at: expiresAt,
      })),
    );
  }

  async getUploadStatus(video: Video): Promise<UploadStatus> {
    if (
      video.processing_status !== 'uploading' &&
      video.processing_status !== 'completing'
    ) {
      throw new InvalidVideoStateException(video.processing_status);
    }
    await this.reserveControlCall(video.id);
    if (!video.upload_id) {
      throw new InvalidVideoStateException(video.processing_status);
    }

    let parts: StoredPart[];
    try {
      parts = await this.storage.listParts(
        originalKey(video.id),
        video.upload_id,
      );
    } catch (error) {
      if (error instanceof StorageError)
        throw new StorageUnavailableException();
      throw error;
    }
    const present = new Set(parts.map((p) => p.partNumber));
    const missing: number[] = [];
    for (let n = 1; n <= video.expected_part_count; n++) {
      if (!present.has(n)) missing.push(n);
    }
    return {
      processing_status: video.processing_status,
      part_size_bytes: video.part_size_bytes,
      expected_part_count: video.expected_part_count,
      upload_expires_at: video.upload_expires_at.toISOString(),
      parts: parts.map((p) => ({
        part_number: p.partNumber,
        size_bytes: p.sizeBytes,
        etag: p.etag,
      })),
      missing_part_numbers: missing,
    };
  }

  /**
   * Cancels an incomplete upload. The row becomes `cancelled` (releasing the
   * quota) ONLY after storage proves every session of the key is gone and no
   * object exists; an indeterminate result changes nothing (fail-closed).
   */
  async abort(video: Video): Promise<void> {
    if (video.processing_status === 'cancelled') return;
    if (video.processing_status !== 'uploading') {
      throw new InvalidVideoStateException(video.processing_status);
    }
    const { upload_binding_token: token } = await this.dataSource
      .getRepository(Video)
      .createQueryBuilder('video')
      .select('video.id')
      .addSelect('video.upload_binding_token')
      .where('video.id = :id', { id: video.id })
      .getOneOrFail();

    const outcome = await confirmUploadsGone(
      this.storage,
      originalKey(video.id),
      video.upload_id ? [video.upload_id] : [],
      token,
    );
    if (outcome === 'completed') {
      throw new InvalidVideoStateException('completed');
    }
    if (outcome === 'indeterminate') {
      throw new StorageUnavailableException();
    }
    await this.dataSource.query(
      `UPDATE "videos" SET "processing_status" = 'cancelled'
       WHERE id = $1 AND "processing_status" = 'uploading'`,
      [video.id],
    );
  }

  /**
   * Shared one-hour window of GET …/upload and POST …/complete, reserved
   * before any storage call (phase-03-videos/TD-13).
   */
  async reserveControlCall(videoId: string): Promise<void> {
    const reserved = await reserveWindowedCall(
      this.dataSource.manager,
      videoId,
      'control',
      ABUSE_LIMITS.CONTROL_CALLS_PER_HOUR,
    );
    if (!reserved) {
      throw new UploadControlRateExceededException(
        ABUSE_LIMITS.CONTROL_CALLS_PER_HOUR,
      );
    }
  }

  private assertUploading(video: Video): void {
    if (video.processing_status !== 'uploading' || !video.upload_id) {
      throw new InvalidVideoStateException(video.processing_status);
    }
    if (video.upload_expires_at.getTime() <= Date.now()) {
      throw new UploadExpiredException();
    }
  }
}
