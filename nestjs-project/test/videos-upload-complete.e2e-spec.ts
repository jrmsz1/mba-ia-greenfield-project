/**
 * E2E for SI-03.11 — authored from nestjs-project/specs/videos-upload-complete.plan.md
 * (one test per scenario, scenario ids in the test names). CompleteMultipartUpload
 * goes through a real fault proxy in front of the pinned MinIO; every other
 * storage call goes straight to MinIO.
 */
import { randomBytes } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import request from 'supertest';
import { PGBOSS, QUEUES } from '../src/queue/queue.constants';
import {
  buildS3Clients,
  type S3Clients,
} from '../src/storage/s3-clients.provider';
import { originalKey } from '../src/storage/storage-key';
import {
  startS3FaultProxy,
  type S3FaultProxy,
} from '../src/test/s3-fault-proxy';
import { fetchPresigned, testStorageConfig } from '../src/test/test-storage';
import { Video } from '../src/videos/entities/video.entity';
import {
  bodyField,
  closeVideosApp,
  createLoggedInOwner,
  createVideosApp,
  resetVideosState,
  type E2eUser,
  type VideosE2e,
} from './support/videos-e2e';

jest.setTimeout(120_000);

const MIB = 1024 * 1024;
const SIZE = 7 * MIB; // two parts: 5 MiB + 2 MiB

interface PartUrl {
  part_number: number;
  url: string;
}

interface Uploaded {
  id: string;
  parts: { part_number: number; etag: string }[];
}

describe('videos-upload-complete', () => {
  let ctx: VideosE2e;
  let proxy: S3FaultProxy;
  let appClients: S3Clients;
  let boss: PgBoss;
  let owner: E2eUser;
  let defaultPartSize: number;

  const http = () => request(ctx.app.getHttpServer());
  const auth = (token = owner.token) => `Bearer ${token}`;

  const row = async (publicId: string) =>
    await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });

  const jobsFor = async (publicId: string) =>
    await boss.findJobs(QUEUES.VIDEO_PROCESS, {
      key: (await row(publicId)).id,
    });

  const putPart = async (
    id: string,
    partNumber: number,
    size: number,
  ): Promise<string> => {
    const res = await http()
      .post(`/videos/${id}/upload/part-urls`)
      .set('Authorization', auth())
      .send({ part_numbers: [partNumber] });
    const [part] = bodyField(res, 'parts') as PartUrl[];
    const put = await fetchPresigned(part.url, {
      method: 'PUT',
      body: randomBytes(size),
    });
    expect(put.status).toBe(200);
    return put.headers.etag as string;
  };

  /** Starts a 2-part video and uploads both parts like a browser would. */
  const uploadedVideo = async (): Promise<Uploaded> => {
    const res = await http()
      .post('/videos')
      .set('Authorization', auth())
      .set('Idempotency-Key', `k-${randomBytes(4).toString('hex')}`)
      .send({ filename: 'clip.mp4', size_bytes: SIZE });
    expect(res.status).toBe(201);
    const id = bodyField(res, 'id') as string;
    return {
      id,
      parts: [
        { part_number: 1, etag: await putPart(id, 1, 5 * MIB) },
        { part_number: 2, etag: await putPart(id, 2, 2 * MIB) },
      ],
    };
  };

  const complete = (id: string, parts: Uploaded['parts'], token?: string) =>
    http()
      .post(`/videos/${id}/upload/complete`)
      .set('Authorization', auth(token))
      .send({ parts });

  const startControlWindowMinutesAgo = async (
    id: string,
    minutes: number,
  ): Promise<void> => {
    await ctx.dataSource.query(
      `UPDATE "videos" SET "control_window_started_at" = now() - make_interval(mins => $2) WHERE public_id = $1`,
      [id, minutes],
    );
  };

  beforeAll(async () => {
    const config = testStorageConfig();
    proxy = await startS3FaultProxy(config.endpoint);
    const direct = buildS3Clients(config);
    const viaProxy = buildS3Clients({ ...config, endpoint: proxy.endpoint });
    appClients = { ...direct, singleAttempt: viaProxy.singleAttempt };
    // The unused clients are released right away.
    viaProxy.internal.destroy();
    viaProxy.publicSigner.destroy();
    ctx = await createVideosApp({ s3Clients: appClients });
    boss = ctx.app.get<PgBoss>(PGBOSS);
    defaultPartSize = ctx.upload.partSizeBytes;
  });

  afterAll(async () => {
    ctx.upload.partSizeBytes = defaultPartSize;
    await closeVideosApp(ctx);
    for (const c of [
      appClients.internal,
      appClients.singleAttempt,
      appClients.publicSigner,
    ]) {
      c.destroy();
    }
    await proxy.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    proxy.failAllCompletes(null);
    ctx.upload.partSizeBytes = 5 * MIB;
    await resetVideosState(ctx);
    await boss.deleteAllJobs(QUEUES.VIDEO_PROCESS);
    owner = await createLoggedInOwner(ctx);
  });

  // 1. Conclusão

  it('1.1 complete-with-correct-manifest', async () => {
    const { id, parts } = await uploadedVideo();

    const res = await complete(id, parts);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, processing_status: 'uploaded' });
    const video = await row(id);
    const jobs = await jobsFor(id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual({ videoId: video.id });
    const head = await ctx.storage.headObject(originalKey(video.id));
    expect(head?.contentLength).toBe(SIZE);
    const { upload_binding_token: token } = await ctx.dataSource
      .getRepository(Video)
      .createQueryBuilder('v')
      .addSelect('v.upload_binding_token')
      .where('v.id = :id', { id: video.id })
      .getOneOrFail();
    expect(head?.uploadBinding).toBe(token);
  });

  it('1.2 repeated-complete-is-idempotent', async () => {
    const { id, parts } = await uploadedVideo();
    await complete(id, parts);

    const res = await complete(id, parts);

    expect(res.status).toBe(200);
    expect(bodyField(res, 'processing_status')).toBe('uploaded');
    expect(await jobsFor(id)).toHaveLength(1);
  });

  it('1.3 complete-while-completing-returns-202', async () => {
    const { id, parts } = await uploadedVideo();
    await ctx.dataSource.query(
      `UPDATE "videos" SET "processing_status" = 'completing', "completing_since" = now() WHERE public_id = $1`,
      [id],
    );
    // The claim holder's Complete is still failing transiently.
    proxy.failAllCompletes({
      kind: 'error-200-no-forward',
      code: 'InternalError',
    });

    const res = await complete(id, parts);

    expect(res.status).toBe(202);
    expect(res.headers['retry-after']).toBe('60');
    expect(bodyField(res, 'processing_status')).toBe('completing');
  });

  it('1.4 invalid-and-mismatched-manifests', async () => {
    const { id, parts } = await uploadedVideo();

    const reordered = await complete(id, [parts[1], parts[0]]);
    expect(reordered.status).toBe(400);
    expect(bodyField(reordered, 'error')).toBe('VALIDATION_ERROR');

    const swapped = await complete(id, [
      parts[0],
      { part_number: 2, etag: `"${'0'.repeat(32)}"` },
    ]);
    expect(swapped.status).toBe(409);
    expect(bodyField(swapped, 'error')).toBe('UPLOAD_PARTS_MISMATCH');
    expect(bodyField(swapped, 'message')).toContain('2');
    expect((await row(id)).processing_status).toBe('uploading');

    await putPart(id, 2, 2 * MIB); // same number, new content
    const replaced = await complete(id, parts);
    expect(replaced.status).toBe(409);
    expect(bodyField(replaced, 'error')).toBe('UPLOAD_PARTS_MISMATCH');
  });

  it('1.5 other-user-gets-404', async () => {
    const { id, parts } = await uploadedVideo();
    const other = await createLoggedInOwner(ctx);

    const res = await complete(id, parts, other.token);

    expect(res.status).toBe(404);
    expect(bodyField(res, 'error')).toBe('VIDEO_NOT_FOUND');
    expect((await row(id)).processing_status).toBe('uploading');
  });

  // 2. Resultado ambíguo

  it('2.1 lost-complete-response-stays-completing', async () => {
    const { id, parts } = await uploadedVideo();
    proxy.failNextComplete({ kind: 'drop-after-forward' });

    const first = await complete(id, parts);

    expect(first.status).toBe(202);
    expect(first.headers['retry-after']).toBe('60');
    expect((await row(id)).processing_status).toBe('completing');
    expect(await jobsFor(id)).toHaveLength(0);
    const second = await complete(id, parts);
    expect(second.status).toBe(200);
    expect(bodyField(second, 'processing_status')).toBe('uploaded');
    expect(await jobsFor(id)).toHaveLength(1);
  });

  it('2.2 embedded-error-in-200-is-not-success', async () => {
    const a = await uploadedVideo();
    proxy.failNextComplete({
      kind: 'error-200-no-forward',
      code: 'InternalError',
    });
    const transient = await complete(a.id, a.parts);
    expect(transient.status).toBe(202);
    expect((await row(a.id)).processing_status).toBe('completing');

    const b = await uploadedVideo();
    proxy.failNextComplete({
      kind: 'error-200-no-forward',
      code: 'InvalidPart',
    });
    const definitive = await complete(b.id, b.parts);
    expect(definitive.status).toBe(409);
    expect(bodyField(definitive, 'error')).toBe('UPLOAD_PARTS_MISMATCH');
    expect((await row(b.id)).processing_status).toBe('uploading');
  });

  // 3. Limite de chamadas de controle

  it('3.1 complete-blocked-after-shared-limit', async () => {
    const { id, parts } = await uploadedVideo();
    for (let i = 0; i < 120; i++) {
      const res = await http()
        .get(`/videos/${id}/upload`)
        .set('Authorization', auth());
      expect(res.status).toBe(200);
    }
    const storageCalls = [
      jest.spyOn(ctx.storage, 'listParts'),
      jest.spyOn(ctx.storage, 'completeMultipartUpload'),
      jest.spyOn(ctx.storage, 'headObject'),
    ];

    const res = await complete(id, parts);

    expect(res.status).toBe(429);
    expect(bodyField(res, 'error')).toBe('UPLOAD_CONTROL_RATE_EXCEEDED');
    for (const spy of storageCalls) expect(spy).not.toHaveBeenCalled();
  });

  it('3.2 legit-upload-completes-after-window-resets', async () => {
    const { id, parts } = await uploadedVideo();
    for (let i = 0; i < 120; i++) {
      await http().get(`/videos/${id}/upload`).set('Authorization', auth());
    }
    const blocked = await complete(id, parts);
    expect(blocked.status).toBe(429);
    expect((await row(id)).processing_status).toBe('uploading');

    await startControlWindowMinutesAgo(id, 61);
    const res = await complete(id, parts);

    expect(res.status).toBe(200);
    expect(bodyField(res, 'processing_status')).toBe('uploaded');
  });

  it('3.3 client-following-retry-after-stays-under-limit', async () => {
    const { id, parts } = await uploadedVideo();
    proxy.failAllCompletes({
      kind: 'error-200-no-forward',
      code: 'InternalError',
    });

    for (let i = 0; i < 60; i++) {
      const res = await complete(id, parts);
      expect(res.status).toBe(202);
      expect((await row(id)).processing_status).toBe('completing');
    }

    proxy.failAllCompletes(null);
    const res = await complete(id, parts);
    expect(res.status).toBe(200);
    expect(bodyField(res, 'processing_status')).toBe('uploaded');
    expect(await jobsFor(id)).toHaveLength(1);
  });

  // 4. Concurrent HTTP completions (Gate 5, final regression)

  it('4.1 five-concurrent-http-completions', async () => {
    const { id, parts } = await uploadedVideo();

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => complete(id, parts)),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.every((s) => s === 200 || s === 202)).toBe(true);
    expect(statuses).toContain(200);
    for (const res of responses) {
      expect(bodyField(res, 'processing_status')).toMatch(
        /^(uploaded|completing)$/,
      );
      if (res.status === 202) expect(res.headers['retry-after']).toBe('60');
    }
    expect((await row(id)).processing_status).toBe('uploaded');
    expect(await jobsFor(id)).toHaveLength(1);
  });
});
