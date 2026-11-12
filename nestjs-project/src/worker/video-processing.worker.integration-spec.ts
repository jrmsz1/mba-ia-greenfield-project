/**
 * SI-03.14 — VideoProcessingWorker against real pg-boss, PostgreSQL, the
 * pinned MinIO and the worker image's FFmpeg. Runs in the worker container
 * (`npm run test:media`); skipped where ffprobe is absent (the API image).
 */
import { type INestApplication, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PgBoss } from 'pg-boss';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import workerConfig from '../config/worker.config';
import { FfprobeRunner } from '../media/ffprobe.runner';
import { MediaToolError } from '../media/media-errors';
import { JOB_TEMP_DIR_PREFIX } from '../media/media.constants';
import { MediaModule } from '../media/media.module';
import { runTool } from '../media/process-runner';
import { PGBOSS, QUEUES, VIDEO_PROCESS_RETRY } from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { UPLOAD_BINDING_METADATA_KEY } from '../storage/storage.constants';
import { originalKey, thumbnailKey } from '../storage/storage-key';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestTypeOrmModule,
} from '../test/create-test-data-source';
import { testQueueSchema } from '../test/test-queue';
import { emptyTestBucket, testStorageConfig } from '../test/test-storage';
import { buildS3Clients, type S3Clients } from '../storage/s3-clients.provider';
import {
  buildVideoValues,
  createTestOwner,
  type TestOwner,
} from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingWorker } from './video-processing.worker';

jest.setTimeout(180_000);

const hasFfmpeg = spawnSync('ffprobe', ['-version']).status === 0;
if (!hasFfmpeg && process.env.MEDIA_TOOLS_REQUIRED === '1') {
  throw new Error('MEDIA_TOOLS_REQUIRED=1 but ffprobe is not installed here');
}
const describeMedia = hasFfmpeg ? describe : describe.skip;

const ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const SETTLED = new Set(['ready', 'failed']);

describeMedia('VideoProcessingWorker (real pg-boss + MinIO + FFmpeg)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let boss: PgBoss;
  let storage: StorageService;
  let probe: FfprobeRunner;
  let owner: TestOwner;
  let fixtures: string;
  let logs: string[];
  let s3: S3Clients;

  const row = async (id: string) =>
    await dataSource.getRepository(Video).findOneByOrFail({ id });

  /** Waits until the row settles (ready/failed) or `until` holds. */
  const waitFor = async (
    id: string,
    until: (v: Video) => boolean = (v) => SETTLED.has(v.processing_status),
  ): Promise<Video> => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const v = await row(id);
      if (until(v)) return v;
      if (Date.now() > deadline) {
        throw new Error(`video ${id} stuck in ${v.processing_status}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  const jobsOf = async (id: string) =>
    await boss.findJobs(QUEUES.VIDEO_PROCESS, { key: id });

  const waitJobsCompleted = async (id: string, count: number) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const jobs = await jobsOf(id);
      if (jobs.filter((j) => j.state === 'completed').length >= count) {
        return jobs;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('jobs not completed in time');
  };

  /**
   * An `uploaded` video whose original is the given fixture (or absent),
   * stored like a completed multipart upload: with this upload's binding
   * metadata, unless `binding` overrides it.
   */
  const uploadedVideo = async (
    fixture: string | null,
    binding?: string,
  ): Promise<string> => {
    const body = fixture ? await readFile(join(fixtures, fixture)) : null;
    const video = await dataSource.getRepository(Video).save(
      dataSource.getRepository(Video).create({
        public_id: randomBytes(8).toString('hex').slice(0, 11),
        ...buildVideoValues(owner.channel.id, {
          processing_status: 'uploaded',
          declared_size_bytes: body ? body.length : 1024,
          part_size_bytes: 5 * 1024 * 1024,
          expected_part_count: 1,
        }),
      }),
    );
    if (body) {
      await s3.internal.send(
        new PutObjectCommand({
          Bucket: storage.bucket,
          Key: originalKey(video.id),
          Body: body,
          ContentType: 'video/mp4',
          Metadata: {
            [UPLOAD_BINDING_METADATA_KEY]:
              binding ?? video.upload_binding_token,
          },
        }),
      );
    }
    return video.id;
  };

  /** Same payload and options as JobPublisherService, with a short retry delay. */
  const send = async (videoId: string, retryDelay = 1) =>
    await boss.send(
      QUEUES.VIDEO_PROCESS,
      { videoId },
      {
        singletonKey: videoId,
        retryLimit: VIDEO_PROCESS_RETRY.LIMIT,
        retryDelay,
        retryBackoff: false,
      },
    );

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), 'worker-fixtures-'));
    const gen = await runTool(
      'sh',
      ['test/fixtures/media/generate.sh', fixtures],
      120_000,
    );
    expect(gen.code).toBe(0);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, queueConfig, workerConfig, storageConfig],
        }),
        createTestTypeOrmModule(ENTITIES, { synchronize: false }),
        StorageModule,
        MediaModule,
        QueueModule.register({ role: 'worker' }),
      ],
      providers: [VideoProcessingWorker],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // boss.start
    await app.get(VideoProcessingWorker).start(); // work() registration, as main.worker.ts
    dataSource = app.get(DataSource);
    boss = app.get<PgBoss>(PGBOSS);
    storage = app.get(StorageService);
    probe = app.get(FfprobeRunner);
    s3 = buildS3Clients(testStorageConfig());
  });

  afterAll(async () => {
    await app.close();
    s3.internal.destroy();
    s3.singleAttempt.destroy();
    s3.publicSigner.destroy();
    await rm(fixtures, { recursive: true, force: true });
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      const original = Logger.prototype[level];
      jest.spyOn(Logger.prototype, level).mockImplementation(function (
        this: Logger,
        ...args: unknown[]
      ) {
        logs.push(args.map(String).join(' '));
        original.apply(this, args as [unknown]);
      });
    }
    await cleanAllTables(dataSource);
    await boss.deleteAllJobs(QUEUES.VIDEO_PROCESS);
    await emptyTestBucket(s3.internal, storage.bucket);
    owner = await createTestOwner(dataSource);
  });

  afterEach(() => {
    for (const line of logs) {
      expect(line).not.toMatch(/X-Amz-|Signature=/i);
    }
  });

  it('takes a valid uploaded video to ready with duration, metadata, thumbnail and a job carrying only videoId', async () => {
    const id = await uploadedVideo('h264-aac-faststart.mp4');
    await send(id);

    const video = await waitFor(id);

    expect(video).toMatchObject({
      processing_status: 'ready',
      processing_attempts: 1,
      failure_reason: null,
    });
    expect(video.duration_seconds).toBeGreaterThan(0);
    expect(video.media_metadata).toMatchObject({
      major_brand: 'isom',
      video: { codec_name: 'h264', pix_fmt: 'yuv420p' },
      audio: { codec_name: 'aac' },
    });
    expect(video.thumbnail_generated_at).toBeInstanceOf(Date);
    const thumb = await storage.headObject(thumbnailKey(id));
    expect(thumb?.contentLength).toBeGreaterThan(0);
    const [job] = await waitJobsCompleted(id, 1);
    expect(job.data).toEqual({ videoId: id });
  });

  it('fails an HEVC video as UNSUPPORTED_FORMAT after a single attempt', async () => {
    const id = await uploadedVideo('hevc.mp4');
    await send(id);

    const video = await waitFor(id);

    expect(video).toMatchObject({
      processing_status: 'failed',
      failure_reason: 'UNSUPPORTED_FORMAT',
      processing_attempts: 1,
    });
    const [job] = await waitJobsCompleted(id, 1);
    expect(job.retryCount).toBe(0);
  });

  it('retries a transient error: ready with processing_attempts = 2 and a fresh input URL per attempt', async () => {
    const id = await uploadedVideo('h264-no-audio.mp4');
    const spy = jest
      .spyOn(probe, 'probe')
      .mockRejectedValueOnce(
        new MediaToolError('transient', 'ffprobe', 'Connection reset by peer'),
      );
    await send(id);

    const video = await waitFor(id);

    expect(video).toMatchObject({
      processing_status: 'ready',
      processing_attempts: 2,
    });
    expect(spy).toHaveBeenCalledTimes(2);
    const [first, second] = spy.mock.calls.map((c) => c[0]);
    expect(first).not.toBe(second);
    // The failed attempt's stored output holds no URL or signature.
    const outputs: { output: string | null }[] = await dataSource.query(
      `SELECT output::text AS output FROM "${testQueueSchema()}".job WHERE singleton_key = $1`,
      [id],
    );
    for (const { output } of outputs) {
      expect(output ?? '').not.toMatch(/X-Amz-|http:\/\//i);
    }
  });

  it('two deliveries leave one thumbnail and a single transition to ready', async () => {
    const id = await uploadedVideo('h264-aac-faststart.mp4');
    await send(id);
    await waitFor(id);
    await waitJobsCompleted(id, 1);
    const put = jest.spyOn(storage, 'putObject');

    await send(id); // late duplicate delivery after completion
    await waitJobsCompleted(id, 2);

    expect(put).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({
      processing_status: 'ready',
      processing_attempts: 1,
    });
  });

  it('a retry of a video whose original was removed never runs the probe and does not end ready', async () => {
    const id = await uploadedVideo(null);
    const spy = jest.spyOn(probe, 'probe');
    await send(id);

    const video = await waitFor(id);

    expect(spy).not.toHaveBeenCalled();
    expect(video).toMatchObject({
      processing_status: 'failed',
      failure_reason: 'PROCESSING_FAILED',
    });
  });

  it('a stale attempt re-claimed during processing cannot conclude the video', async () => {
    const id = await uploadedVideo('h264-no-audio.mp4');
    const put = jest.spyOn(storage, 'putObject');
    const real = probe.probe.bind(probe) as FfprobeRunner['probe'];
    jest.spyOn(probe, 'probe').mockImplementationOnce(async (input) => {
      // Another worker re-claims the video while this attempt is running.
      await dataSource.query(
        `UPDATE "videos" SET "processing_attempts" = "processing_attempts" + 1 WHERE id = $1`,
        [id],
      );
      return await real(input);
    });
    await send(id);

    await waitJobsCompleted(id, 1);

    expect(await row(id)).toMatchObject({
      processing_status: 'processing',
      processing_attempts: 2,
    });
    // The stale attempt never writes (or overwrites) the thumbnail.
    expect(put).not.toHaveBeenCalled();
    expect(await storage.headObject(thumbnailKey(id))).toBeNull();
    expect(logs.some((l) => l.includes('processing_superseded'))).toBe(true);
  });

  it('refuses an original carrying another upload binding as UPLOAD_INVALID, without probing or deleting it', async () => {
    const id = await uploadedVideo('h264-no-audio.mp4', 'foreign-binding');
    const spy = jest.spyOn(probe, 'probe');
    const del = jest.spyOn(storage, 'deleteObject');
    await send(id);

    const video = await waitFor(id);

    expect(video).toMatchObject({
      processing_status: 'failed',
      failure_reason: 'UPLOAD_INVALID',
    });
    expect(spy).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(await storage.headObject(originalKey(id))).not.toBeNull();
  });

  it('holds no open transaction while the media tools run', async () => {
    const id = await uploadedVideo('h264-no-audio.mp4');
    const real = probe.probe.bind(probe) as FfprobeRunner['probe'];
    let openTransactions = -1;
    jest.spyOn(probe, 'probe').mockImplementationOnce(async (input) => {
      const rows: { n: string }[] = await dataSource.query(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE datname = current_database() AND state LIKE 'idle in transaction%'`,
      );
      openTransactions = Number(rows[0].n);
      return await real(input);
    });
    await send(id);

    await waitFor(id);

    expect(openTransactions).toBe(0);
  });

  it('never persists a presigned URL: failure_reason holds only domain codes and no temp dir is left', async () => {
    const ids = [
      await uploadedVideo('text.mp4'),
      await uploadedVideo('h264-6s.mp4'),
    ];
    for (const id of ids) await send(id);
    for (const id of ids) await waitFor(id);

    const reasons: { failure_reason: string | null }[] = await dataSource.query(
      `SELECT failure_reason FROM videos`,
    );
    for (const { failure_reason } of reasons) {
      expect(failure_reason ?? '').toMatch(/^([A-Z_]+)?$/);
    }
    const leftovers = (await readdir(tmpdir())).filter((d) =>
      d.startsWith(JOB_TEMP_DIR_PREFIX),
    );
    expect(leftovers).toEqual([]);
  });
});
