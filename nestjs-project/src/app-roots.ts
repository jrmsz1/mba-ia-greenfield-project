import type { DynamicModule } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from './config/app.config';
import authConfig from './config/auth.config';
import databaseConfig from './config/database.config';
import {
  envValidationSchema,
  workerEnvValidationSchema,
} from './config/env.validation';
import mailConfig from './config/mail.config';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import swaggerConfig from './config/swagger.config';
import uploadConfig from './config/upload.config';
import workerConfig from './config/worker.config';

/**
 * Root modules shared by both entrypoints — the HTTP API (AppModule) and the
 * video worker (WorkerModule) — so they validate the same environment and
 * open the database the same way (phase-03-videos/TD-06).
 */
export type ProcessRole = 'api' | 'worker';

export function rootConfigModule(
  role: ProcessRole = 'api',
): ReturnType<typeof ConfigModule.forRoot> {
  return ConfigModule.forRoot({
    isGlobal: true,
    load: [
      appConfig,
      authConfig,
      databaseConfig,
      mailConfig,
      swaggerConfig,
      storageConfig,
      uploadConfig,
      workerConfig,
      queueConfig,
    ],
    // Each process validates only its own storage credentials (TD-16).
    validationSchema:
      role === 'worker' ? workerEnvValidationSchema : envValidationSchema,
    validationOptions: { allowUnknown: true, abortEarly: false },
  });
}

export function rootTypeOrmModule(): DynamicModule {
  return TypeOrmModule.forRootAsync({
    imports: [ConfigModule],
    inject: [databaseConfig.KEY],
    useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
      type: 'postgres',
      host: dbConfig.host,
      port: dbConfig.port,
      username: dbConfig.username,
      password: dbConfig.password,
      database: dbConfig.name,
      autoLoadEntities: true,
      synchronize: false,
    }),
  });
}
