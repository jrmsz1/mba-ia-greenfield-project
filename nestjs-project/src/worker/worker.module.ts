import { Module } from '@nestjs/common';
import { rootConfigModule, rootTypeOrmModule } from '../app-roots';
import { MediaModule } from '../media/media.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { UploadRecoveryService } from '../videos/upload-recovery.service';
import { VideoProcessingWorker } from './video-processing.worker';
import { VideoReconcilerWorker } from './video-reconciler.worker';

/** Exported by reference so the compile test can replace it (no database). */
export const workerDatabaseModule = rootTypeOrmModule();

/**
 * Video worker application context (phase-03-videos/TD-06): no HTTP server.
 * The `worker` role gives pg-boss its supervisor and scheduler (TD-05);
 * VideoProcessingWorker consumes video.process (SI-03.14) and
 * VideoReconcilerWorker runs the scheduled video.reconcile (SI-03.15).
 */
@Module({
  imports: [
    rootConfigModule('worker'),
    workerDatabaseModule,
    StorageModule,
    MediaModule,
    QueueModule.register({ role: 'worker' }),
  ],
  providers: [
    VideoProcessingWorker,
    VideoReconcilerWorker,
    UploadRecoveryService,
  ],
})
export class WorkerModule {}
