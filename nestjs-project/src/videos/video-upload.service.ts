import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { IsNull, type DataSource, type EntityManager } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import uploadConfig from '../config/upload.config';
import { confirmUploadsGone } from '../storage/multipart-cleanup';
import { StorageError, StorageRejectedError } from '../storage/storage-errors';
import { originalKey } from '../storage/storage-key';
import { StorageService } from '../storage/storage.service';
import { QUOTA_HOLDING_STATUSES } from './abuse-limits';
import { Video } from './entities/video.entity';
import { insertWithUniquePublicId } from './public-id.generator';
import { withVideoSessionLock } from './video-session-lock';
import {
  assertUploadAdmitted,
  planParts,
  sanitizeFilename,
  type OwnerUsage,
} from './upload-admission';
import { resolveTitle } from './video-title';
import {
  ChannelRequiredException,
  IdempotencyKeyConflictException,
  StorageUnavailableException,
  UploadSizeExceededException,
  UploadStartInProgressException,
} from './video.exceptions';

export interface StartUploadInput {
  filename: string;
  sizeBytes: number;
  contentType?: string;
  title?: string;
}

export interface StartUploadResult {
  video: Video;
  /** true when this call created the reservation (201), false on a replay (200). */
  created: boolean;
}

/**
 * "Start upload": the private draft, its quota reservation and the S3
 * multipart upload (phase-03-videos/TD-01, TD-02, TD-09, TD-13; plan SI-03.7).
 *
 * Phase 1 — ONE PostgreSQL transaction: lock the owner's `users` row, check
 * idempotency and every quota, insert the reservation, COMMIT. No storage
 * call happens inside it.
 *
 * Phase 2 — after that commit, no transaction open during storage I/O: a
 * non-blocking per-video session advisory lock on a dedicated connection
 * serializes the multipart creation of one reservation; every write is a
 * short autocommit statement.
 */
@Injectable()
export class VideoUploadService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    @Inject(uploadConfig.KEY)
    private readonly upload: ConfigType<typeof uploadConfig>,
  ) {}

  async start(
    userId: string,
    idempotencyKey: string,
    input: StartUploadInput,
  ): Promise<StartUploadResult> {
    if (input.sizeBytes > this.upload.maxUploadBytes) {
      throw new UploadSizeExceededException(this.upload.maxUploadBytes);
    }
    const filename = sanitizeFilename(input.filename);
    const reservation = await this.reserve(userId, idempotencyKey, {
      ...input,
      filename,
      title: resolveTitle(input.title, filename),
    });
    const video = await this.ensureMultipartUpload(reservation.video);
    return { video, created: reservation.created };
  }

  /**
   * Phase 1: atomic quota reservation (single transaction, fail-closed).
   * `input` carries the sanitized file name and the resolved title.
   */
  private async reserve(
    userId: string,
    idempotencyKey: string,
    input: StartUploadInput & { title: string },
  ): Promise<StartUploadResult> {
    return await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT id FROM "users" WHERE id = $1 FOR UPDATE', [
        userId,
      ]);
      const channel = await manager.findOne(Channel, {
        where: { user_id: userId },
      });
      if (!channel) {
        throw new ChannelRequiredException();
      }

      const existing = await manager.findOne(Video, {
        where: { channel_id: channel.id, idempotency_key: idempotencyKey },
      });
      if (existing) {
        if (
          existing.original_filename !== input.filename ||
          existing.declared_size_bytes !== input.sizeBytes ||
          existing.title !== input.title
        ) {
          throw new IdempotencyKeyConflictException();
        }
        return { video: existing, created: false };
      }

      assertUploadAdmitted(
        await this.ownerUsage(manager, userId),
        input.sizeBytes,
        {
          maxActiveUploadsPerOwner: this.upload.maxActiveUploadsPerOwner,
          maxPendingUploadBytesPerOwner:
            this.upload.maxPendingUploadBytesPerOwner,
        },
      );

      const parts = planParts(input.sizeBytes, this.upload.partSizeBytes);
      const video = await insertWithUniquePublicId(manager, {
        channel_id: channel.id,
        processing_status: 'uploading',
        idempotency_key: idempotencyKey,
        title: input.title,
        original_filename: input.filename,
        content_type_hint: input.contentType ?? null,
        declared_size_bytes: input.sizeBytes,
        part_size_bytes: parts.partSizeBytes,
        expected_part_count: parts.expectedPartCount,
        upload_id: null,
        upload_binding_token: randomBytes(32).toString('hex'),
        upload_expires_at: new Date(
          Date.now() + this.upload.expiryHours * 3_600_000,
        ),
      });
      return { video, created: true };
    });
  }

  /** Usage summed over every channel of the owner (multi-channel safe). */
  private async ownerUsage(
    manager: EntityManager,
    userId: string,
  ): Promise<OwnerUsage> {
    const rows: {
      active: string;
      pending: string | null;
      recent: string;
    }[] = await manager.query(
      `SELECT
         count(*) FILTER (WHERE v.processing_status = ANY($2::video_processing_status[]))::text AS active,
         coalesce(sum(v.declared_size_bytes) FILTER (WHERE v.processing_status = ANY($2::video_processing_status[])), 0)::text AS pending,
         count(*) FILTER (WHERE v.created_at > now() - interval '1 hour')::text AS recent
       FROM "videos" v
       JOIN "channels" c ON c.id = v.channel_id
       WHERE c.user_id = $1`,
      [userId, QUOTA_HOLDING_STATUSES],
    );
    return {
      activeUploads: Number(rows[0].active),
      pendingBytes: Number(rows[0].pending ?? 0),
      startsLastHour: Number(rows[0].recent),
    };
  }

  /** Phase 2: create (or recover) the multipart upload of a reservation. */
  private async ensureMultipartUpload(reserved: Video): Promise<Video> {
    if (reserved.upload_id) return reserved;
    const locked = await withVideoSessionLock(
      this.dataSource,
      reserved.id,
      async () =>
        await this.createOrRecover(this.dataSource.manager, reserved.id),
    );
    if (!locked.acquired) throw new UploadStartInProgressException();
    return locked.value;
  }

  private async createOrRecover(
    manager: EntityManager,
    videoId: string,
  ): Promise<Video> {
    const row = await manager
      .createQueryBuilder(Video, 'video')
      .addSelect('video.upload_binding_token')
      .where('video.id = :videoId', { videoId })
      .getOneOrFail();
    if (row.upload_id) return row;

    const key = originalKey(row.id);
    const priorAttempt = row.multipart_create_attempted_at !== null;
    await manager.update(
      Video,
      { id: row.id },
      {
        multipart_create_attempted_at: new Date(),
      },
    );

    if (priorAttempt) {
      // A previous attempt may have created a session whose response was
      // lost: prove the exclusive key is clean before creating another one.
      const outcome = await confirmUploadsGone(
        this.storage,
        key,
        [],
        row.upload_binding_token,
      );
      if (outcome !== 'aborted') {
        throw new StorageUnavailableException();
      }
    }

    let uploadId: string;
    try {
      uploadId = await this.storage.createMultipartUpload(
        key,
        row.upload_binding_token,
        row.content_type_hint ?? undefined,
      );
    } catch (error) {
      if (error instanceof StorageRejectedError) {
        // Definitive: no session exists, so the reservation can go.
        await manager.delete(Video, { id: row.id, upload_id: IsNull() });
        throw new StorageUnavailableException();
      }
      if (error instanceof StorageError) {
        // Ambiguous/transient: a session may exist; keep the reservation.
        throw new StorageUnavailableException();
      }
      throw error;
    }

    await manager
      .createQueryBuilder()
      .update(Video)
      .set({ upload_id: uploadId })
      .where('id = :id AND upload_id IS NULL', { id: row.id })
      .execute();
    return await manager.findOneByOrFail(Video, { id: row.id });
  }
}
