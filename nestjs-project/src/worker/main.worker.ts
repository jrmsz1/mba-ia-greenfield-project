import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { VideoProcessingWorker } from './video-processing.worker';
import { WorkerModule } from './worker.module';

const logger = new Logger('Worker');
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * Second entrypoint of nestjs-project: the video worker (phase-03-videos/TD-06).
 *
 * Shutdown is graceful in every phase:
 * - while booting, a signal exits right away — no job can have been claimed
 *   yet, because consumption only starts after the shutdown hooks are in
 *   place (Compose runs the process under `init: true`, so the signal is also
 *   honored while Node is still loading modules);
 * - after boot, shutdown hooks close the context, which stops pg-boss
 *   gracefully (TD-05) and lets an active job finish or be re-delivered.
 */
async function bootstrap(): Promise<void> {
  const exitDuringBoot = (signal: string): void => {
    logger.log(`${signal} during boot: exiting before consuming any job`);
    process.exit(0);
  };
  for (const signal of SHUTDOWN_SIGNALS) process.once(signal, exitDuringBoot);

  const app = await NestFactory.createApplicationContext(WorkerModule);

  for (const signal of SHUTDOWN_SIGNALS) process.off(signal, exitDuringBoot);
  app.enableShutdownHooks();
  await app.get(VideoProcessingWorker).start();
  logger.log('Video worker started');
}
void bootstrap();
