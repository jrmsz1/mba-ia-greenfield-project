import { Module } from '@nestjs/common';
import { rootConfigModule, rootTypeOrmModule } from '../app-roots';
import { MediaModule } from '../media/media.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';

/** Exported by reference so the compile test can replace it (no database). */
export const workerDatabaseModule = rootTypeOrmModule();

/**
 * Video worker application context (phase-03-videos/TD-06): no HTTP server.
 * The `worker` role gives pg-boss its supervisor and scheduler (TD-05);
 * processing and reconciliation handlers join in SI-03.14 and SI-03.15.
 */
@Module({
  imports: [
    rootConfigModule(),
    workerDatabaseModule,
    StorageModule,
    MediaModule,
    QueueModule.register({ role: 'worker' }),
  ],
})
export class WorkerModule {}
