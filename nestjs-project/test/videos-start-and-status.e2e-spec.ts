/**
 * E2E for SI-03.8 — authored from nestjs-project/specs/videos-start-and-status.plan.md
 * (one test per scenario, scenario ids in the test names).
 */
import request from 'supertest';
import { Video } from '../src/videos/entities/video.entity';
import { originalKey } from '../src/storage/storage-key';
import {
  StorageRejectedError,
  StorageUnavailableError,
} from '../src/storage/storage-errors';
import {
  bodyField,
  closeVideosApp,
  createLoggedInOwner,
  createVideosApp,
  resetVideosState,
  type E2eUser,
  type VideosE2e,
} from './support/videos-e2e';

jest.setTimeout(60_000);

const MIB = 1024 * 1024;

describe('videos-start-and-status', () => {
  let ctx: VideosE2e;
  let owner: E2eUser;
  let defaults: { maxActive: number; maxPending: number };

  const startUpload = (
    key: string,
    sizeBytes = 12 * MIB,
    token = owner.token,
  ) =>
    request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ filename: 'clip.mp4', size_bytes: sizeBytes });

  const rowByPublicId = async (publicId: string) =>
    await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });

  const sessionsOf = async (video: Video) =>
    await ctx.storage.listMultipartUploads(originalKey(video.id));

  /** Real create, captured in beforeEach before any spy replaces it. */
  let realCreate: typeof ctx.storage.createMultipartUpload;

  const loseNextCreateResponse = () => {
    const real = realCreate;
    return jest
      .spyOn(ctx.storage, 'createMultipartUpload')
      .mockImplementationOnce(
        async (key: string, token: string, type?: string) => {
          await real(key, token, type);
          throw new StorageUnavailableError(
            'ambiguous',
            'TimeoutError',
            'lost',
          );
        },
      );
  };

  beforeAll(async () => {
    ctx = await createVideosApp();
    defaults = {
      maxActive: ctx.upload.maxActiveUploadsPerOwner,
      maxPending: ctx.upload.maxPendingUploadBytesPerOwner,
    };
  });

  afterAll(async () => {
    await closeVideosApp(ctx);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    ctx.upload.maxActiveUploadsPerOwner = defaults.maxActive;
    ctx.upload.maxPendingUploadBytesPerOwner = defaults.maxPending;
    realCreate = ctx.storage.createMultipartUpload.bind(
      ctx.storage,
    ) as typeof ctx.storage.createMultipartUpload;
    await resetVideosState(ctx);
    owner = await createLoggedInOwner(ctx);
  });

  // 1. Início do upload

  it('1.1 start-creates-private-draft', async () => {
    const res = await startUpload('k-1');

    expect(res.status).toBe(201);
    expect(bodyField(res, 'id')).toEqual(
      expect.stringMatching(/^[0-9A-Za-z]{11}$/),
    );
    expect(bodyField(res, 'upload_id')).toEqual(expect.any(String));
    expect(bodyField(res, 'part_size_bytes')).toEqual(expect.any(Number));
    expect(bodyField(res, 'expected_part_count')).toEqual(expect.any(Number));
    const expiresAt = Date.parse(bodyField(res, 'upload_expires_at') as string);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(bodyField(res, 'processing_status')).toBe('uploading');
    expect(bodyField(res, 'publication')).toBe('draft');
    const row = await rowByPublicId(bodyField(res, 'id') as string);
    expect(row.upload_id).toBe(bodyField(res, 'upload_id'));
    expect(await sessionsOf(row)).toEqual([row.upload_id]);
  });

  it('1.2 start-retry-is-idempotent', async () => {
    const first = await startUpload('k-2');
    const replay = await startUpload('k-2');
    const conflict = await startUpload('k-2', 13 * MIB);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(bodyField(replay, 'id')).toBe(bodyField(first, 'id'));
    expect(bodyField(replay, 'upload_id')).toBe(bodyField(first, 'upload_id'));
    expect(await ctx.dataSource.getRepository(Video).count()).toBe(1);
    expect(
      await sessionsOf(await rowByPublicId(bodyField(first, 'id') as string)),
    ).toHaveLength(1);
    expect(conflict.status).toBe(409);
    expect(bodyField(conflict, 'error')).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('1.3 start-validation-and-size-limit', async () => {
    const noKey = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ filename: 'clip.mp4', size_bytes: 12 * MIB });
    const tooLarge = await startUpload('k-3', ctx.upload.maxUploadBytes + 1);

    expect(noKey.status).toBe(400);
    expect(bodyField(noKey, 'error')).toBe('VALIDATION_ERROR');
    expect(tooLarge.status).toBe(400);
    expect(bodyField(tooLarge, 'error')).toBe('UPLOAD_SIZE_EXCEEDED');
    expect(await ctx.dataSource.getRepository(Video).count()).toBe(0);
  });

  it('1.4 start-is-not-throttled-by-auth-limit', async () => {
    ctx.upload.maxActiveUploadsPerOwner = 100;
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await startUpload(`burst-${i}`, 6 * MIB);
      statuses.push(res.status);
    }

    expect(statuses.every((status) => status === 201)).toBe(true);
  });

  it('1.5 start-without-token-is-rejected', async () => {
    const created = await startUpload('k-5');
    const post = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Idempotency-Key', 'k-5b')
      .send({ filename: 'clip.mp4', size_bytes: 6 * MIB });
    const get = await request(ctx.app.getHttpServer()).get(
      `/videos/${bodyField(created, 'id') as string}`,
    );

    expect(post.status).toBe(401);
    expect(get.status).toBe(401);
  });

  // 2. Falhas e recuperação de CreateMultipartUpload

  it('2.1 definitive-create-failure-deletes-reservation', async () => {
    jest
      .spyOn(ctx.storage, 'createMultipartUpload')
      .mockRejectedValueOnce(
        new StorageRejectedError('definitive', 'AccessDenied', 'no'),
      );

    const failed = await startUpload('r-1');

    expect(failed.status).toBe(503);
    expect(bodyField(failed, 'error')).toBe('STORAGE_UNAVAILABLE');
    expect(failed.headers['retry-after']).toEqual(expect.any(String));
    expect(await ctx.dataSource.getRepository(Video).count()).toBe(0);
    expect((await startUpload('r-2')).status).toBe(201);
  });

  it('2.2 ambiguous-create-keeps-reservation-and-retry-recovers', async () => {
    ctx.upload.maxActiveUploadsPerOwner = 1;
    loseNextCreateResponse();

    const lost = await startUpload('k-lost');
    const reservation = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ idempotency_key: 'k-lost' });
    const blocked = await startUpload('k-other');
    const retried = await startUpload('k-lost');

    expect(lost.status).toBe(503);
    expect(bodyField(lost, 'error')).toBe('STORAGE_UNAVAILABLE');
    expect(reservation.upload_id).toBeNull();
    expect(reservation.multipart_create_attempted_at).not.toBeNull();
    expect(blocked.status).toBe(429);
    expect(bodyField(blocked, 'error')).toBe('ACTIVE_UPLOAD_LIMIT_EXCEEDED');
    expect(retried.status).toBe(200);
    expect(bodyField(retried, 'upload_id')).toEqual(expect.any(String));
    expect(await sessionsOf(reservation)).toEqual([
      bodyField(retried, 'upload_id'),
    ]);
  });

  it('2.3 concurrent-retries-create-one-session', async () => {
    loseNextCreateResponse();
    expect((await startUpload('c-1')).status).toBe(503);
    const real = realCreate;
    jest
      .spyOn(ctx.storage, 'createMultipartUpload')
      .mockImplementation(async (key: string, token: string, type?: string) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return await real(key, token, type);
      });

    const results = await Promise.all([
      startUpload('c-1'),
      startUpload('c-1'),
      startUpload('c-1'),
    ]);

    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(2);
    for (const loser of losers) {
      expect(bodyField(loser, 'error')).toBe('UPLOAD_START_IN_PROGRESS');
      expect(loser.headers['retry-after']).toEqual(expect.any(String));
    }
    const row = await rowByPublicId(bodyField(winners[0], 'id') as string);
    expect(await sessionsOf(row)).toEqual([row.upload_id]);
  });

  it('2.4 indeterminate-investigation-keeps-reservation', async () => {
    loseNextCreateResponse();
    expect((await startUpload('u-1')).status).toBe(503);
    jest
      .spyOn(ctx.storage, 'listMultipartUploads')
      .mockRejectedValue(
        new StorageUnavailableError('transient', 'ECONNREFUSED', 'down'),
      );
    const create = jest.spyOn(ctx.storage, 'createMultipartUpload');
    create.mockClear();

    const res = await startUpload('u-1');

    expect(res.status).toBe(503);
    expect(bodyField(res, 'error')).toBe('STORAGE_UNAVAILABLE');
    expect(create).not.toHaveBeenCalled();
    const reservation = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ idempotency_key: 'u-1' });
    expect(reservation.upload_id).toBeNull();
  });

  // 3. Status do rascunho

  it('3.1 owner-reads-draft-others-get-404', async () => {
    const created = await startUpload('s-1');
    const id = bodyField(created, 'id') as string;
    const intruder = await createLoggedInOwner(ctx);

    const mine = await request(ctx.app.getHttpServer())
      .get(`/videos/${id}`)
      .set('Authorization', `Bearer ${owner.token}`);
    const theirs = await request(ctx.app.getHttpServer())
      .get(`/videos/${id}`)
      .set('Authorization', `Bearer ${intruder.token}`);
    const malformed = await request(ctx.app.getHttpServer())
      .get('/videos/not-a-valid-id')
      .set('Authorization', `Bearer ${owner.token}`);

    expect(mine.status).toBe(200);
    expect(bodyField(mine, 'publication')).toBe('draft');
    expect(bodyField(mine, 'processing_status')).toBe('uploading');
    expect(bodyField(mine, 'has_thumbnail')).toBe(false);
    expect(bodyField(mine, 'upload_id')).toBeUndefined();
    expect(bodyField(mine, 'upload_binding_token')).toBeUndefined();
    expect(theirs.status).toBe(404);
    expect(bodyField(theirs, 'error')).toBe('VIDEO_NOT_FOUND');
    expect(malformed.status).toBe(404);
    expect(bodyField(malformed, 'error')).toBe('VIDEO_NOT_FOUND');
  });
});
