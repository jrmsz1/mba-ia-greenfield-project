import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { JobPublisherService } from '../queue/job-publisher.service';
import { StorageError, UploadNotFoundError } from '../storage/storage-errors';
import { originalKey } from '../storage/storage-key';
import { StorageService, type ManifestPart } from '../storage/storage.service';
import { evaluateCompletionProof } from './completion-proof';
import { Video } from './entities/video.entity';
import { FAILURE_REASONS, type VideoProcessingStatus } from './video.constants';
import { firstRows } from './windowed-counter';

export type RecoveryOutcome =
  | 'uploaded'
  | 'failed'
  | 'expired'
  | 'released'
  | 'pending';

export interface ResolveOptions {
  /** Server-verified manifest, when the caller has one. */
  manifest?: ManifestPart[];
  /**
   * Allow `completing → uploading` when the upload is still open and no object
   * exists. Only the reconciler sets it, for stale claims — a client call may
   * race with a Complete still in flight (phase-03-videos/TD-02 step 7).
   */
  allowRelease?: boolean;
}

/**
 * Evidence-based resolution of an upload whose outcome is unknown, shared by
 * the repeated `complete` and the reconciler (phase-03-videos/TD-02 revision
 * IC-1, TD-09 revision IC-1). Every transition is compare-and-set; ambiguous
 * evidence changes nothing.
 */
@Injectable()
export class UploadRecoveryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly publisher: JobPublisherService,
  ) {}

  async resolve(
    videoId: string,
    options: ResolveOptions = {},
  ): Promise<RecoveryOutcome> {
    const video = await this.loadWithToken(videoId);
    if (
      video.processing_status !== 'uploading' &&
      video.processing_status !== 'completing'
    ) {
      return 'pending';
    }
    const from: VideoProcessingStatus[] = [video.processing_status];
    const key = originalKey(video.id);
    try {
      // 1) Is the upload session still open? Checked BEFORE the object: the
      //    object exists before the session disappears on completion.
      let uploadGone = !video.upload_id;
      if (video.upload_id) {
        try {
          await this.storage.listParts(key, video.upload_id);
        } catch (error) {
          if (!(error instanceof UploadNotFoundError)) throw error;
          uploadGone = true;
        }
      }

      // 2) What is at the exclusive key?
      const head = await this.storage.headObject(key);
      const proof = evaluateCompletionProof({
        head,
        declaredSizeBytes: video.declared_size_bytes,
        bindingToken: video.upload_binding_token,
        manifest: options.manifest,
      });

      if (proof === 'proven') {
        return (await this.markUploaded(video.id, from))
          ? 'uploaded'
          : 'pending';
      }
      if (proof === 'contradicted') {
        return (await this.markInvalid(video.id, from)) ? 'failed' : 'pending';
      }
      if (head !== null) return 'pending'; // object present, proof unknown

      if (uploadGone) {
        if (video.upload_expires_at.getTime() <= Date.now()) {
          return (await this.transition(video.id, from, 'expired', null))
            ? 'expired'
            : 'pending';
        }
        return (await this.transition(
          video.id,
          from,
          'failed',
          FAILURE_REASONS.UPLOAD_LOST,
        ))
          ? 'failed'
          : 'pending';
      }

      if (options.allowRelease && video.processing_status === 'completing') {
        return (await this.transition(
          video.id,
          ['completing'],
          'uploading',
          null,
        ))
          ? 'released'
          : 'pending';
      }
      return 'pending';
    } catch (error) {
      if (error instanceof StorageError) return 'pending';
      throw error;
    }
  }

  /** `from → uploaded` and the `video.process` job, in ONE transaction (TD-05). */
  async markUploaded(
    videoId: string,
    from: VideoProcessingStatus[],
  ): Promise<boolean> {
    return await this.dataSource.transaction(async (manager) => {
      const rows: unknown[] = await manager.query(
        `UPDATE "videos" SET "processing_status" = 'uploaded', "failure_reason" = NULL
         WHERE id = $1 AND "processing_status" = ANY($2::video_processing_status[])
         RETURNING id`,
        [videoId, from],
      );
      if (firstRows(rows).length === 0) return false;
      await this.publisher.publishVideoProcess(videoId, manager);
      return true;
    });
  }

  /** Positive contradiction: `failed`/`UPLOAD_INVALID` and the object deleted. */
  async markInvalid(
    videoId: string,
    from: VideoProcessingStatus[],
  ): Promise<boolean> {
    const moved = await this.transition(
      videoId,
      from,
      'failed',
      FAILURE_REASONS.UPLOAD_INVALID,
    );
    if (moved) {
      await this.storage.deleteObject(originalKey(videoId));
    }
    return moved;
  }

  /** Compare-and-set status change; false when the row was not in `from`. */
  async transition(
    videoId: string,
    from: VideoProcessingStatus[],
    to: VideoProcessingStatus,
    failureReason: string | null,
  ): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query(
      `UPDATE "videos" SET "processing_status" = $3, "failure_reason" = $4
       WHERE id = $1 AND "processing_status" = ANY($2::video_processing_status[])
       RETURNING id`,
      [videoId, from, to, failureReason],
    );
    return firstRows(rows).length > 0;
  }

  async loadWithToken(videoId: string): Promise<Video> {
    return await this.dataSource
      .getRepository(Video)
      .createQueryBuilder('video')
      .addSelect('video.upload_binding_token')
      .where('video.id = :videoId', { videoId })
      .getOneOrFail();
  }
}
