import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { PgBoss } from 'pg-boss';
import type { EntityManager } from 'typeorm';
import workerConfig from '../config/worker.config';
import { PGBOSS, QUEUES, VIDEO_PROCESS_RETRY } from './queue.constants';
import { fromTypeOrm } from './typeorm-pgboss-db.adapter';

export interface VideoProcessPayload {
  /** Internal UUID only — never a URL, a storage key or a credential. */
  videoId: string;
}

/**
 * The API side of the queue: it only publishes (phase-03-videos/TD-05, TD-06).
 */
@Injectable()
export class JobPublisherService {
  constructor(
    @Inject(PGBOSS) private readonly boss: PgBoss,
    @Inject(workerConfig.KEY)
    private readonly worker: ConfigType<typeof workerConfig>,
  ) {}

  /**
   * Enqueues `video.process` for one video. With `manager`, the insert joins
   * that TypeORM transaction (commit keeps it, rollback discards it). Without
   * it (reconciler re-publication), it runs on pg-boss's own pool. The
   * singletonKey = video id makes repeated calls harmless: `null` means a
   * queued-or-active job for this video already exists.
   */
  async publishVideoProcess(
    videoId: string,
    manager?: EntityManager,
  ): Promise<string | null> {
    const payload: VideoProcessPayload = { videoId };
    return await this.boss.send(QUEUES.VIDEO_PROCESS, payload, {
      ...(manager ? { db: fromTypeOrm(manager) } : {}),
      singletonKey: videoId,
      retryLimit: VIDEO_PROCESS_RETRY.LIMIT,
      retryDelay: VIDEO_PROCESS_RETRY.DELAY_SECONDS,
      retryBackoff: VIDEO_PROCESS_RETRY.BACKOFF,
      expireInSeconds: this.worker.jobTimeoutSeconds,
    });
  }
}
