import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { PgBoss } from 'pg-boss';
import type { DataSource } from 'typeorm';
import queueConfig from '../config/queue.config';
import uploadConfig from '../config/upload.config';
import { JobPublisherService } from '../queue/job-publisher.service';
import { assertQueueSchemaName } from '../queue/pgboss-schema';
import { PGBOSS, QUEUES, RECONCILE_CRON } from '../queue/queue.constants';
import {
  confirmUploadsGone,
  type CleanupOptions,
} from '../storage/multipart-cleanup';
import { originalKey } from '../storage/storage-key';
import { StorageService } from '../storage/storage.service';
import { RESERVATION_STALE_MINUTES } from '../videos/abuse-limits';
import { UploadRecoveryService } from '../videos/upload-recovery.service';
import { withVideoSessionLock } from '../videos/video-session-lock';
import { firstRows } from '../videos/windowed-counter';

/** Rows examined per category and run; the next run picks up the rest. */
export const RECONCILE_BATCH = 100;

export interface ReconcileReport {
  expired: number;
  expiryResolvedByProof: number;
  reservationsRemoved: number;
  staleClaimsResolved: number;
  republished: number;
  /**
   * An object with a missing or foreign upload-binding was found at the key:
   * `failed`/`UPLOAD_INVALID`, object retained, no job (TD-02/TD-09 rev.).
   */
  identityContradictions: number;
  /** Storage could not prove the outcome: nothing changed, retried next run. */
  indeterminate: number;
  /** Another process held the video's session lock: skipped this run. */
  lockedSkipped: number;
}

const emptyReport = (): ReconcileReport => ({
  expired: 0,
  expiryResolvedByProof: 0,
  reservationsRemoved: 0,
  identityContradictions: 0,
  staleClaimsResolved: 0,
  republished: 0,
  indeterminate: 0,
  lockedSkipped: 0,
});

/**
 * Scheduled reaper/reconciler (phase-03-videos/TD-14, TD-02, TD-09, TD-05).
 * Safety rules:
 * - every per-video action runs under the SAME non-blocking session lock as
 *   the upload start (SI-03.7) and moves the row only by compare-and-set, so
 *   overlapping runs (or a run racing the API) cannot duplicate a transition
 *   or an effect;
 * - capacity is released (`expired`, reservation removed) only on positive
 *   cleanup evidence from `confirmUploadsGone` (`aborted`). An unreachable
 *   storage or an empty listing is never read as "no upload": it yields
 *   `indeterminate` and the quota stays reserved;
 * - the reconciler never deletes objects. When cleanup is `indeterminate`,
 *   only a SUCCESSFUL HeadObject showing a missing or foreign upload-binding
 *   moves the row to `failed`/`UPLOAD_INVALID` (object retained, no job);
 *   a storage error, an absent object or a session still open change nothing.
 */
@Injectable()
export class VideoReconcilerWorker {
  private readonly logger = new Logger(VideoReconcilerWorker.name);

  constructor(
    @Inject(PGBOSS) private readonly boss: PgBoss,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly recovery: UploadRecoveryService,
    private readonly publisher: JobPublisherService,
    @Inject(uploadConfig.KEY)
    private readonly upload: ConfigType<typeof uploadConfig>,
    @Inject(queueConfig.KEY)
    private readonly queue: ConfigType<typeof queueConfig>,
  ) {}

  /** Called by main.worker.ts after the shutdown hooks are installed. */
  async start(): Promise<void> {
    await this.boss.schedule(QUEUES.VIDEO_RECONCILE, RECONCILE_CRON);
    await this.boss.work(QUEUES.VIDEO_RECONCILE, async () => {
      const report = await this.runOnce();
      this.logger.log(JSON.stringify({ event: 'reconcile_run', ...report }));
    });
  }

  async runOnce(cleanup: CleanupOptions = {}): Promise<ReconcileReport> {
    const report = emptyReport();
    await this.reapExpiredUploads(report, cleanup);
    await this.reapOrphanReservations(report, cleanup);
    await this.resolveStaleClaims(report);
    await this.republishMissingJobs(report);
    return report;
  }

  /** (a) `uploading` past `upload_expires_at`. */
  private async reapExpiredUploads(
    report: ReconcileReport,
    cleanup: CleanupOptions,
  ): Promise<void> {
    const ids = await this.ids(
      `SELECT id FROM "videos"
        WHERE "processing_status" = 'uploading' AND "upload_id" IS NOT NULL
          AND "upload_expires_at" <= now()
        ORDER BY "upload_expires_at" LIMIT $1`,
    );
    for (const id of ids) {
      await this.locked(report, id, async () => {
        const video = await this.recovery.loadWithToken(id);
        if (video.processing_status !== 'uploading') return;
        const outcome = await confirmUploadsGone(
          this.storage,
          originalKey(id),
          video.upload_id ? [video.upload_id] : [],
          video.upload_binding_token,
          cleanup,
        );
        if (outcome === 'aborted') {
          if (
            await this.cas(
              `UPDATE "videos" SET "processing_status" = 'expired'
                WHERE id = $1 AND "processing_status" = 'uploading'
                  AND "upload_expires_at" <= now()
                RETURNING id`,
              id,
            )
          ) {
            report.expired++;
          }
        } else if (outcome === 'completed') {
          // A completed object follows the completion proof, never `expired`.
          const resolved = await this.recovery.resolve(id);
          if (resolved === 'uploaded') report.expiryResolvedByProof++;
          else if (resolved === 'pending') report.indeterminate++;
        } else {
          await this.afterIndeterminate(report, id);
        }
      });
    }
  }

  /** (b) Reservations that never got an `upload_id`. */
  private async reapOrphanReservations(
    report: ReconcileReport,
    cleanup: CleanupOptions,
  ): Promise<void> {
    const ids = await this.ids(
      `SELECT id FROM "videos"
        WHERE "processing_status" = 'uploading' AND "upload_id" IS NULL
          AND "created_at" < now() - make_interval(mins => ${RESERVATION_STALE_MINUTES})
        ORDER BY "created_at" LIMIT $1`,
    );
    for (const id of ids) {
      // The upload start holds this lock while it creates the session.
      await this.locked(report, id, async () => {
        const video = await this.recovery.loadWithToken(id);
        if (video.processing_status !== 'uploading' || video.upload_id) {
          return;
        }
        // A session may exist even without upload_id (create attempted,
        // response lost): investigate the exclusive key itself.
        const outcome = await confirmUploadsGone(
          this.storage,
          originalKey(id),
          [],
          video.upload_binding_token,
          cleanup,
        );
        if (outcome !== 'aborted') {
          await this.afterIndeterminate(report, id);
          return;
        }
        if (
          await this.cas(
            `DELETE FROM "videos"
              WHERE id = $1 AND "processing_status" = 'uploading'
                AND "upload_id" IS NULL
              RETURNING id`,
            id,
          )
        ) {
          report.reservationsRemoved++;
        }
      });
    }
  }

  /** (c) `completing` claims older than COMPLETING_STALE_MINUTES. */
  private async resolveStaleClaims(report: ReconcileReport): Promise<void> {
    const ids = await this.ids(
      `SELECT id FROM "videos"
        WHERE "processing_status" = 'completing'
          AND "completing_since" < now() - make_interval(mins => $2::int)
        ORDER BY "completing_since" LIMIT $1`,
      [this.upload.completingStaleMinutes],
    );
    for (const id of ids) {
      await this.locked(report, id, async () => {
        const outcome = await this.recovery.resolve(id, { allowRelease: true });
        if (outcome === 'pending') report.indeterminate++;
        else report.staleClaimsResolved++;
      });
    }
  }

  /** (d) `uploaded` rows whose `video.process` job is missing. */
  private async republishMissingJobs(report: ReconcileReport): Promise<void> {
    const schema = this.queue.schema;
    assertQueueSchemaName(schema);
    const ids = await this.ids(
      `SELECT v.id FROM "videos" v
        WHERE v."processing_status" = 'uploaded'
          AND NOT EXISTS (
            SELECT 1 FROM "${schema}".job j
             WHERE j.name = $2 AND j.singleton_key = v.id::text
               AND j.state IN ('created', 'retry', 'active'))
        ORDER BY v."created_at" LIMIT $1`,
      [QUEUES.VIDEO_PROCESS],
    );
    for (const id of ids) {
      // exclusive policy + singletonKey: a concurrent run cannot add a second.
      if ((await this.publisher.publishVideoProcess(id)) !== null) {
        report.republished++;
      }
    }
  }

  /**
   * `confirmUploadsGone` could not prove the key empty: refuse a foreign
   * object if one is positively there, otherwise leave everything as is.
   */
  private async afterIndeterminate(
    report: ReconcileReport,
    videoId: string,
  ): Promise<void> {
    const refused = await this.recovery.refuseForeignObject(videoId);
    if (refused === 'failed') report.identityContradictions++;
    else report.indeterminate++;
  }

  private async locked(
    report: ReconcileReport,
    videoId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const result = await withVideoSessionLock(this.dataSource, videoId, work);
    if (!result.acquired) report.lockedSkipped++;
  }

  private async ids(sql: string, extra: unknown[] = []): Promise<string[]> {
    const rows: { id: string }[] = await this.dataSource.query(sql, [
      RECONCILE_BATCH,
      ...extra,
    ]);
    return rows.map((r) => r.id);
  }

  private async cas(sql: string, id: string): Promise<boolean> {
    const result: unknown[] = await this.dataSource.query(sql, [id]);
    return firstRows(result).length > 0;
  }
}
