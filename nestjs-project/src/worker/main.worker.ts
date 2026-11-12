import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Second entrypoint of nestjs-project: the video worker (phase-03-videos/TD-06).
 * Shutdown hooks make SIGTERM (`docker compose stop worker`) close the
 * application context, which stops pg-boss gracefully (TD-05).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  new Logger('Worker').log('Video worker started');
}
void bootstrap();
