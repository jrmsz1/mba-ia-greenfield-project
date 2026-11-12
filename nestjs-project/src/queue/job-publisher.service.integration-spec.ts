import { type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { DataSource } from 'typeorm';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import workerConfig from '../config/worker.config';
import { createTestTypeOrmModule } from '../test/create-test-data-source';
import { testQueueSchema } from '../test/test-queue';
import { JobPublisherService } from './job-publisher.service';
import { PGBOSS, QUEUE_POLICY, QUEUES } from './queue.constants';
import { QueueModule } from './queue.module';

describe('JobPublisherService (real PostgreSQL + pg-boss)', () => {
  let app: INestApplication;
  let publisher: JobPublisherService;
  let boss: PgBoss;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, queueConfig, workerConfig],
        }),
        createTestTypeOrmModule([], { synchronize: false }),
        QueueModule.register({ role: 'api' }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    publisher = app.get(JobPublisherService);
    boss = app.get<PgBoss>(PGBOSS);
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await boss.deleteAllJobs(QUEUES.VIDEO_PROCESS);
  });

  it('creates both queues in the test queue schema with the exclusive policy at startup', async () => {
    const tables: unknown[] = await dataSource.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'version'`,
      [testQueueSchema()],
    );

    expect(tables).toHaveLength(1);
    expect(await boss.getQueue(QUEUES.VIDEO_PROCESS)).toMatchObject({
      name: QUEUES.VIDEO_PROCESS,
      policy: QUEUE_POLICY,
    });
    expect(await boss.getQueue(QUEUES.VIDEO_RECONCILE)).toMatchObject({
      name: QUEUES.VIDEO_RECONCILE,
      policy: QUEUE_POLICY,
    });
  });

  it('publishes one job per video: a repeated publish for the same video is deduplicated', async () => {
    const videoId = randomUUID();

    const first = await dataSource.transaction(
      async (manager) => await publisher.publishVideoProcess(videoId, manager),
    );
    const second = await dataSource.transaction(
      async (manager) => await publisher.publishVideoProcess(videoId, manager),
    );
    const third = await publisher.publishVideoProcess(videoId);

    expect(first).toEqual(expect.any(String));
    expect(second).toBeNull();
    expect(third).toBeNull();
    const jobs = await boss.findJobs(QUEUES.VIDEO_PROCESS, { key: videoId });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual({ videoId });
  });

  it('keeps deduplicating while the job is active', async () => {
    const videoId = randomUUID();
    await publisher.publishVideoProcess(videoId);
    const [claimed] = await boss.fetch(QUEUES.VIDEO_PROCESS);

    expect(claimed.data).toEqual({ videoId });
    expect(await publisher.publishVideoProcess(videoId)).toBeNull();
  });

  it('publishes nothing when the surrounding transaction rolls back', async () => {
    const videoId = randomUUID();

    await expect(
      dataSource.transaction(async (manager) => {
        await publisher.publishVideoProcess(videoId, manager);
        throw new Error('rollback after publish');
      }),
    ).rejects.toThrow('rollback after publish');

    expect(
      await boss.findJobs(QUEUES.VIDEO_PROCESS, { key: videoId }),
    ).toHaveLength(0);
  });

  it('carries only the internal video id and the configured retry policy', async () => {
    const videoId = randomUUID();
    await publisher.publishVideoProcess(videoId);

    const [job] = await boss.findJobs(QUEUES.VIDEO_PROCESS, { key: videoId });

    expect(job.data).toEqual({ videoId });
    expect(job).toMatchObject({
      singletonKey: videoId,
      retryLimit: 3,
      retryBackoff: true,
      expireInSeconds: workerConfig().jobTimeoutSeconds,
    });
  });
});
