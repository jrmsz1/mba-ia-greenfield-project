import { type INestApplication, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  ThrottlerStorage,
  type ThrottlerStorageService,
} from '@nestjs/throttler';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Channel } from '../../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import uploadConfig from '../../src/config/upload.config';
import { S3_CLIENTS } from '../../src/storage/storage.constants';
import { StorageService } from '../../src/storage/storage.service';
import { cleanAllTables } from '../../src/test/create-test-data-source';
import {
  buildS3Clients,
  type S3Clients,
} from '../../src/storage/s3-clients.provider';
import {
  emptyTestBucket,
  testStorageConfig,
} from '../../src/test/test-storage';
import { User } from '../../src/users/entities/user.entity';

export const E2E_PASSWORD = 'password123';

export interface VideosE2e {
  app: INestApplication<App>;
  dataSource: DataSource;
  storage: StorageService;
  /** Live upload config object: tests may tune limits and must restore them. */
  upload: ConfigType<typeof uploadConfig>;
  throttler: ThrottlerStorageService;
  /** Direct S3 clients on the test bucket, for assertions and cleanup. */
  s3: S3Clients;
}

export interface VideosAppOptions {
  /** Replaces the app's S3 clients (e.g. Complete routed through a fault proxy). */
  s3Clients?: S3Clients;
}

/** Boots AppModule exactly like main.ts (pipes + filters). */
export async function createVideosApp(
  options: VideosAppOptions = {},
): Promise<VideosE2e> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.s3Clients) {
    builder.overrideProvider(S3_CLIENTS).useValue(options.s3Clients);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  // Listen once on an ephemeral port: supertest then reuses this server
  // instead of opening one listener per request (concurrent requests would
  // otherwise race and reset connections).
  await app.listen(0);
  return {
    app,
    dataSource: moduleRef.get(DataSource),
    storage: moduleRef.get(StorageService),
    upload: moduleRef.get<ConfigType<typeof uploadConfig>>(uploadConfig.KEY),
    throttler: moduleRef.get<ThrottlerStorageService>(ThrottlerStorage),
    s3: buildS3Clients(testStorageConfig()),
  };
}

/** Clean tables, test bucket and auth throttling state between tests. */
export async function resetVideosState(ctx: VideosE2e): Promise<void> {
  await cleanAllTables(ctx.dataSource);
  await emptyTestBucket(ctx.s3.internal, ctx.storage.bucket);
  ctx.throttler.storage.clear();
}

export interface E2eUser {
  user: User;
  channel: Channel;
  token: string;
}

/** A confirmed user with a channel, logged in through POST /auth/login. */
export async function createLoggedInOwner(ctx: VideosE2e): Promise<E2eUser> {
  const suffix = randomBytes(5).toString('hex');
  const email = `video_owner_${suffix}@example.com`;
  const user = await ctx.dataSource.getRepository(User).save(
    ctx.dataSource.getRepository(User).create({
      email,
      password: await argon2.hash(E2E_PASSWORD),
      is_confirmed: true,
    }),
  );
  const channel = await ctx.dataSource.getRepository(Channel).save(
    ctx.dataSource.getRepository(Channel).create({
      name: `Channel ${suffix}`,
      nickname: `ch_${suffix}`,
      user_id: user.id,
    }),
  );
  const res = await request(ctx.app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: E2E_PASSWORD });
  const token = bodyField(res, 'access_token');
  if (typeof token !== 'string') {
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { user, channel, token };
}

/** supertest types `res.body` as any; read fields as unknown. */
export function bodyField(res: { body: unknown }, key: string): unknown {
  const body = res.body;
  return typeof body === 'object' && body !== null
    ? Reflect.get(body, key)
    : undefined;
}

export async function closeVideosApp(ctx: VideosE2e): Promise<void> {
  await ctx.app.close();
  ctx.s3.internal.destroy();
  ctx.s3.singleAttempt.destroy();
  ctx.s3.publicSigner.destroy();
}
