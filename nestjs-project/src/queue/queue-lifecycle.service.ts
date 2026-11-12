import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { PgBoss, Queue } from 'pg-boss';
import workerConfig from '../config/worker.config';
import {
  PGBOSS,
  QUEUE_POLICY,
  QUEUES,
  VIDEO_PROCESS_RETRY,
} from './queue.constants';

/**
 * Starts pg-boss, creates the phase 03 queues when missing and stops it
 * gracefully on shutdown (SIGTERM via enableShutdownHooks, TD-05/TD-06).
 */
@Injectable()
export class QueueLifecycleService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(QueueLifecycleService.name);

  constructor(
    @Inject(PGBOSS) private readonly boss: PgBoss,
    @Inject(workerConfig.KEY)
    private readonly worker: ConfigType<typeof workerConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    this.boss.on('error', (error: unknown) =>
      this.logger.error(`pg-boss error: ${String(error)}`),
    );
    await this.boss.start();
    await this.ensureQueue(QUEUES.VIDEO_PROCESS, {
      policy: QUEUE_POLICY,
      retryLimit: VIDEO_PROCESS_RETRY.LIMIT,
      retryDelay: VIDEO_PROCESS_RETRY.DELAY_SECONDS,
      retryBackoff: VIDEO_PROCESS_RETRY.BACKOFF,
      expireInSeconds: this.worker.jobTimeoutSeconds,
    });
    await this.ensureQueue(QUEUES.VIDEO_RECONCILE, { policy: QUEUE_POLICY });
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    await this.boss.stop({ graceful: true });
    this.logger.log(`pg-boss stopped gracefully (${signal ?? 'close'})`);
  }

  private async ensureQueue(
    name: string,
    options: Omit<Queue, 'name'>,
  ): Promise<void> {
    if (await this.boss.getQueue(name)) return;
    try {
      await this.boss.createQueue(name, options);
    } catch (error) {
      // Another process (API vs worker) may have created it concurrently.
      if (await this.boss.getQueue(name)) return;
      throw error;
    }
  }
}
