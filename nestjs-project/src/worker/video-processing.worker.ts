import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import type { DataSource } from 'typeorm';
import workerConfig from '../config/worker.config';
import { FfmpegRunner } from '../media/ffmpeg.runner';
import { FfprobeRunner } from '../media/ffprobe.runner';
import { MediaToolError } from '../media/media-errors';
import { evaluateMedia } from '../media/media-rule';
import { redactPresignedUrl } from '../media/redact';
import {
  thumbnailPositionSeconds,
  withJobTempDir,
} from '../media/thumbnail-policy';
import type { VideoProcessPayload } from '../queue/job-publisher.service';
import { PGBOSS, QUEUES } from '../queue/queue.constants';
import { originalKey, thumbnailKey } from '../storage/storage-key';
import { StorageService } from '../storage/storage.service';
import { FAILURE_REASONS } from '../videos/video.constants';
import { firstRows } from '../videos/windowed-counter';

/** The job fields the handler reads (`includeMetadata: true`). */
export interface ProcessJob {
  id: string;
  data: VideoProcessPayload;
  retryCount: number;
  retryLimit: number;
}

type PermanentReason =
  | typeof FAILURE_REASONS.UNSUPPORTED_FORMAT
  | typeof FAILURE_REASONS.DURATION_LIMIT_EXCEEDED
  | typeof FAILURE_REASONS.PROCESSING_FAILED;

/** A permanent outcome decided during the attempt: no retry. */
class PermanentFailure extends Error {
  constructor(
    readonly reason: PermanentReason,
    detail: string,
  ) {
    super(redactPresignedUrl(detail));
  }
}

export type ProcessOutcome =
  | 'ready'
  | 'failed'
  | 'skipped' // not in uploaded/processing: duplicate or late delivery
  | 'superseded'; // another attempt re-claimed the video meanwhile

/**
 * Consumes `video.process` (phase-03-videos/TD-05, TD-07, TD-08, TD-09):
 * `uploaded → processing → ready | failed`. Idempotent and crash-safe:
 * - the payload is only `videoId`; the row is re-read and re-validated on
 *   EVERY attempt, and a fresh presigned input URL is minted per attempt;
 * - each claim increments `processing_attempts` (the attempt fence); the
 *   final transition only applies to the SAME attempt, so a stale worker
 *   whose attempt was re-claimed after a crash/expiry cannot conclude it;
 * - no transaction is held open while media tools run;
 * - permanent media outcomes finish the job without retry; transient errors
 *   are rethrown (redacted) for pg-boss retry until the limit, then
 *   `failed`/`PROCESSING_FAILED`.
 */
@Injectable()
export class VideoProcessingWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(VideoProcessingWorker.name);

  constructor(
    @Inject(PGBOSS) private readonly boss: PgBoss,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly probe: FfprobeRunner,
    private readonly ffmpeg: FfmpegRunner,
    @Inject(workerConfig.KEY)
    private readonly worker: ConfigType<typeof workerConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work(
      QUEUES.VIDEO_PROCESS,
      { localConcurrency: this.worker.concurrency, includeMetadata: true },
      async ([job]: JobWithMetadata<VideoProcessPayload>[]) => {
        await this.process(job);
      },
    );
  }

  async process(job: ProcessJob): Promise<ProcessOutcome> {
    const { videoId } = job.data;
    const attempt = await this.claim(videoId);
    if (attempt === null) return 'skipped';

    try {
      return await this.runAttempt(videoId, attempt);
    } catch (error) {
      if (error instanceof PermanentFailure) {
        return await this.fail(videoId, attempt, error.reason, error.message);
      }
      const message = redactPresignedUrl(
        error instanceof Error ? error.message : String(error),
      );
      if (job.retryCount >= job.retryLimit) {
        return await this.fail(
          videoId,
          attempt,
          FAILURE_REASONS.PROCESSING_FAILED,
          `retries exhausted: ${message}`,
        );
      }
      this.logger.warn(
        JSON.stringify({
          event: 'processing_retry',
          videoId,
          attempt,
          message,
        }),
      );
      // pg-boss stores this message in the job output: redacted, no URL.
      throw new Error(message);
    }
  }

  /** Short claim, outside any long transaction; null when not processable. */
  private async claim(videoId: string): Promise<number | null> {
    const result: unknown[] = await this.dataSource.query(
      `UPDATE "videos"
            SET "processing_status" = 'processing',
                "processing_attempts" = "processing_attempts" + 1,
                "processing_started_at" = now()
          WHERE id = $1 AND "processing_status" IN ('uploaded', 'processing')
          RETURNING "processing_attempts"`,
      [videoId],
    );
    const rows = firstRows(result) as { processing_attempts: number }[];
    return rows.length > 0 ? rows[0].processing_attempts : null;
  }

  private async runAttempt(
    videoId: string,
    attempt: number,
  ): Promise<ProcessOutcome> {
    const declared = await this.declaredSize(videoId);
    const key = originalKey(videoId);
    // Re-validate before touching the media: the original must still be
    // there with the declared size, or the probe never runs.
    const head = await this.storage.headObject(key);
    if (head === null || head.contentLength !== declared) {
      throw new PermanentFailure(
        FAILURE_REASONS.PROCESSING_FAILED,
        head === null ? 'original missing' : 'original size differs',
      );
    }
    // Fresh per attempt; never persisted, never logged.
    const input = await this.storage.presignInternalGet(
      key,
      this.worker.processingInputPresignTtlSeconds,
    );

    return await withJobTempDir(async (dir) => {
      const probe = await this.probeOrClassify(input);
      const verdict = evaluateMedia(probe, {
        maxDurationSeconds: this.worker.maxVideoDurationSeconds,
      });
      if (!verdict.accepted) {
        throw new PermanentFailure(verdict.reason, verdict.detail);
      }
      const jpeg = join(dir, 'thumbnail.jpg');
      try {
        await this.ffmpeg.extractFrame(
          input,
          thumbnailPositionSeconds(verdict.durationSeconds),
          jpeg,
        );
      } catch (error) {
        if (error instanceof MediaToolError && error.kind === 'permanent') {
          // A frame that cannot be decoded is a processing failure (TD-07).
          throw new PermanentFailure(
            FAILURE_REASONS.PROCESSING_FAILED,
            error.message,
          );
        }
        throw error;
      }
      // Same key on every attempt: a repeated run overwrites, never adds.
      await this.storage.putObject(
        thumbnailKey(videoId),
        await readFile(jpeg),
        'image/jpeg',
      );
      return await this.markReady(
        videoId,
        attempt,
        verdict.durationSeconds,
        verdict.metadata,
      );
    });
  }

  private async probeOrClassify(input: string) {
    try {
      return await this.probe.probe(input);
    } catch (error) {
      if (error instanceof MediaToolError && error.kind === 'permanent') {
        throw new PermanentFailure(
          FAILURE_REASONS.UNSUPPORTED_FORMAT,
          error.message,
        );
      }
      throw error; // transient: retried
    }
  }

  private async declaredSize(videoId: string): Promise<number> {
    const result: unknown[] = await this.dataSource.query(
      `SELECT "declared_size_bytes" FROM "videos" WHERE id = $1`,
      [videoId],
    );
    const rows = result as { declared_size_bytes: string }[];
    return Number(rows[0]?.declared_size_bytes);
  }

  /** Fenced on the attempt: a re-claimed video is never concluded here. */
  private async markReady(
    videoId: string,
    attempt: number,
    durationSeconds: number,
    metadata: object,
  ): Promise<ProcessOutcome> {
    const result: unknown[] = await this.dataSource.query(
      `UPDATE "videos"
            SET "processing_status" = 'ready',
                "duration_seconds" = $3,
                "media_metadata" = $4::jsonb,
                "thumbnail_generated_at" = now(),
                "failure_reason" = NULL
          WHERE id = $1 AND "processing_status" = 'processing'
            AND "processing_attempts" = $2
          RETURNING id`,
      [videoId, attempt, durationSeconds, JSON.stringify(metadata)],
    );
    const rows = firstRows(result);
    return this.concluded(rows.length > 0, 'ready', videoId, attempt);
  }

  private async fail(
    videoId: string,
    attempt: number,
    reason: PermanentReason,
    detail: string,
  ): Promise<ProcessOutcome> {
    // failure_reason holds the domain code only, never the detail.
    const result: unknown[] = await this.dataSource.query(
      `UPDATE "videos" SET "processing_status" = 'failed', "failure_reason" = $3
          WHERE id = $1 AND "processing_status" = 'processing'
            AND "processing_attempts" = $2
          RETURNING id`,
      [videoId, attempt, reason],
    );
    const rows = firstRows(result);
    if (rows.length > 0) {
      this.logger.warn(
        JSON.stringify({
          event: 'processing_failed',
          videoId,
          attempt,
          reason,
          detail: redactPresignedUrl(detail),
        }),
      );
    }
    return this.concluded(rows.length > 0, 'failed', videoId, attempt);
  }

  private concluded(
    applied: boolean,
    outcome: 'ready' | 'failed',
    videoId: string,
    attempt: number,
  ): ProcessOutcome {
    if (applied) return outcome;
    this.logger.warn(
      JSON.stringify({ event: 'processing_superseded', videoId, attempt }),
    );
    return 'superseded';
  }
}
