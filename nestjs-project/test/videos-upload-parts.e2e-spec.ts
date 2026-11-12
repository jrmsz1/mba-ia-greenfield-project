/**
 * E2E for SI-03.9 — authored from nestjs-project/specs/videos-upload-parts.plan.md
 * (one test per scenario, scenario ids in the test names).
 */
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { originalKey } from '../src/storage/storage-key';
import { StorageUnavailableError } from '../src/storage/storage-errors';
import storageConfig from '../src/config/storage.config';
import {
  fetchPresigned,
  readTestStorageTarget,
} from '../src/test/test-storage';
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

jest.setTimeout(90_000);

const MIB = 1024 * 1024;

interface PartUrl {
  part_number: number;
  url: string;
  expires_at: string;
}

describe('videos-upload-parts', () => {
  let ctx: VideosE2e;
  let owner: E2eUser;
  let defaults: { partSize: number; maxActive: number };

  const http = () => request(ctx.app.getHttpServer());
  const auth = (token = owner.token) => `Bearer ${token}`;

  /** Starts a video of `sizeBytes` (5 MiB parts) and returns its public id. */
  const startVideo = async (sizeBytes = 12 * MIB): Promise<string> => {
    const res = await http()
      .post('/videos')
      .set('Authorization', auth())
      .set('Idempotency-Key', `k-${randomBytes(4).toString('hex')}`)
      .send({ filename: 'clip.mp4', size_bytes: sizeBytes });
    expect(res.status).toBe(201);
    return bodyField(res, 'id') as string;
  };

  const partUrls = (id: string, partNumbers: number[]) =>
    http()
      .post(`/videos/${id}/upload/part-urls`)
      .set('Authorization', auth())
      .send({ part_numbers: partNumbers });

  const row = async (publicId: string) =>
    await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });

  beforeAll(async () => {
    ctx = await createVideosApp();
    defaults = {
      partSize: ctx.upload.partSizeBytes,
      maxActive: ctx.upload.maxActiveUploadsPerOwner,
    };
  });

  afterAll(async () => {
    ctx.upload.partSizeBytes = defaults.partSize;
    await closeVideosApp(ctx);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    ctx.upload.partSizeBytes = 5 * MIB;
    ctx.upload.maxActiveUploadsPerOwner = defaults.maxActive;
    await resetVideosState(ctx);
    owner = await createLoggedInOwner(ctx);
  });

  // 1. URLs de parte

  it('1.1 issue-part-urls-batch', async () => {
    const id = await startVideo();
    const requestedAt = Date.now();

    const res = await partUrls(id, [1, 2]);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const parts = bodyField(res, 'parts') as PartUrl[];
    expect(parts.map((p) => p.part_number)).toEqual([1, 2]);
    for (const part of parts) {
      const ttl = (Date.parse(part.expires_at) - requestedAt) / 1000;
      expect(ttl).toBeGreaterThan(ctx.upload.partPresignTtlSeconds - 10);
      expect(ttl).toBeLessThanOrEqual(ctx.upload.partPresignTtlSeconds + 10);
      expect(new URL(part.url).host).toBe(
        new URL(storageConfig().publicEndpoint).host,
      );
      // Signed by the API identity, never delivery or root (TD-04 rev).
      const credential =
        new URL(part.url).searchParams.get('X-Amz-Credential') ?? '';
      expect(credential.split('/')[0]).toBe(
        readTestStorageTarget().identities.api.accessKeyId,
      );
    }
  });

  it('1.2 invalid-part-numbers-rejected', async () => {
    const id = await startVideo();

    const outOfRange = await partUrls(id, [4]);
    const duplicated = await partUrls(id, [1, 1]);

    expect(outOfRange.status).toBe(400);
    expect(bodyField(outOfRange, 'error')).toBe('VALIDATION_ERROR');
    expect(duplicated.status).toBe(400);
    expect(bodyField(duplicated, 'error')).toBe('VALIDATION_ERROR');
  });

  it('1.3 part-urls-after-expiry', async () => {
    const id = await startVideo();
    await ctx.dataSource
      .getRepository(Video)
      .update(
        { public_id: id },
        { upload_expires_at: new Date(Date.now() - 1000) },
      );

    const res = await partUrls(id, [1]);

    expect(res.status).toBe(409);
    expect(bodyField(res, 'error')).toBe('UPLOAD_EXPIRED');
  });

  it('1.4 part-url-issuance-cap', async () => {
    const first = await startVideo(6 * MIB); // 2 parts -> cap 20
    for (let i = 0; i < 10; i++) {
      expect((await partUrls(first, [1, 2])).status).toBe(200);
    }
    const over = await partUrls(first, [1]);
    expect(over.status).toBe(429);
    expect(bodyField(over, 'error')).toBe('PART_URL_LIMIT_EXCEEDED');

    const second = await startVideo(6 * MIB);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => partUrls(second, [1])),
    );
    const accepted = results.filter((r) => r.status === 200).length;
    expect(accepted).toBeLessThanOrEqual(20);
    expect((await row(second)).part_urls_issued).toBeLessThanOrEqual(20);
  });

  // 2. Retomada

  it('2.1 resume-lists-received-and-missing-parts', async () => {
    const id = await startVideo();
    const parts = bodyField(await partUrls(id, [1, 3]), 'parts') as PartUrl[];
    const sent = new Map<number, string>();
    for (const part of parts) {
      const body = randomBytes(part.part_number === 3 ? 2 * MIB : 5 * MIB);
      const put = await fetchPresigned(part.url, { method: 'PUT', body });
      expect(put.status).toBe(200);
      expect(put.headers.etag).toEqual(expect.any(String));
      sent.set(part.part_number, put.headers.etag as string);
    }

    const res = await http()
      .get(`/videos/${id}/upload`)
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(bodyField(res, 'parts')).toEqual([
      { part_number: 1, size_bytes: 5 * MIB, etag: sent.get(1) },
      { part_number: 3, size_bytes: 2 * MIB, etag: sent.get(3) },
    ]);
    expect(bodyField(res, 'missing_part_numbers')).toEqual([2]);
  });

  it('2.2 control-rate-limit-on-status', async () => {
    const id = await startVideo();
    for (let i = 0; i < 120; i++) {
      const res = await http()
        .get(`/videos/${id}/upload`)
        .set('Authorization', auth());
      expect(res.status).toBe(200);
    }
    const listParts = jest.spyOn(ctx.storage, 'listParts');

    const res = await http()
      .get(`/videos/${id}/upload`)
      .set('Authorization', auth());

    expect(res.status).toBe(429);
    expect(bodyField(res, 'error')).toBe('UPLOAD_CONTROL_RATE_EXCEEDED');
    expect(listParts).not.toHaveBeenCalled();
  });

  it('2.3 control-rate-limit-is-shared-with-complete', async () => {
    const id = await startVideo();
    // Full-length manifest for parts storage does not hold yet.
    const parts = [1, 2, 3].map((n) => ({
      part_number: n,
      etag: `"${randomBytes(16).toString('hex')}"`,
    }));
    for (let i = 0; i < 100; i++) {
      const res = await http()
        .get(`/videos/${id}/upload`)
        .set('Authorization', auth());
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < 20; i++) {
      const res = await http()
        .post(`/videos/${id}/upload/complete`)
        .set('Authorization', auth())
        .send({ parts });
      expect(res.status).toBe(409);
      expect(bodyField(res, 'error')).toBe('UPLOAD_PARTS_MISMATCH');
    }

    const res = await http()
      .get(`/videos/${id}/upload`)
      .set('Authorization', auth());

    expect(res.status).toBe(429);
    expect(bodyField(res, 'error')).toBe('UPLOAD_CONTROL_RATE_EXCEEDED');
  });

  // 3. Cancelamento

  it('3.1 abort-cancels-and-invalidates-part-urls', async () => {
    const id = await startVideo();
    const [part] = bodyField(await partUrls(id, [2]), 'parts') as PartUrl[];

    const first = await http()
      .delete(`/videos/${id}/upload`)
      .set('Authorization', auth());
    const put = await fetchPresigned(part.url, {
      method: 'PUT',
      body: randomBytes(5 * MIB),
    });
    const again = await http()
      .delete(`/videos/${id}/upload`)
      .set('Authorization', auth());

    expect(first.status).toBe(204);
    expect((await row(id)).processing_status).toBe('cancelled');
    expect(put.status).not.toBe(200);
    expect(again.status).toBe(204);
  });

  it('3.2 abort-rejected-while-completing', async () => {
    const id = await startVideo();
    await ctx.dataSource
      .getRepository(Video)
      .update({ public_id: id }, { processing_status: 'completing' });

    const res = await http()
      .delete(`/videos/${id}/upload`)
      .set('Authorization', auth());

    expect(res.status).toBe(409);
    expect(bodyField(res, 'error')).toBe('INVALID_VIDEO_STATE');
  });

  it('3.3 abort-with-storage-down-keeps-reservation', async () => {
    ctx.upload.maxActiveUploadsPerOwner = 1;
    const id = await startVideo();
    jest
      .spyOn(ctx.storage, 'listMultipartUploads')
      .mockRejectedValue(
        new StorageUnavailableError('transient', 'ECONNREFUSED', 'down'),
      );

    const res = await http()
      .delete(`/videos/${id}/upload`)
      .set('Authorization', auth());
    jest.restoreAllMocks();
    const blocked = await http()
      .post('/videos')
      .set('Authorization', auth())
      .set('Idempotency-Key', 'k-after-failed-abort')
      .send({ filename: 'clip.mp4', size_bytes: 6 * MIB });

    expect(res.status).toBe(503);
    expect(bodyField(res, 'error')).toBe('STORAGE_UNAVAILABLE');
    expect((await row(id)).processing_status).toBe('uploading');
    expect(blocked.status).toBe(429);
    expect(bodyField(blocked, 'error')).toBe('ACTIVE_UPLOAD_LIMIT_EXCEEDED');
  });

  it('3.4 abort-repeated-until-confirmed', async () => {
    const id = await startVideo();
    const realAbort = ctx.storage.abortMultipartUpload.bind(
      ctx.storage,
    ) as typeof ctx.storage.abortMultipartUpload;
    const abortSpy = jest
      .spyOn(ctx.storage, 'abortMultipartUpload')
      .mockRejectedValueOnce(
        new StorageUnavailableError('transient', 'SlowDown', 'busy'),
      )
      .mockImplementation(realAbort);

    const confirmed = await http()
      .delete(`/videos/${id}/upload`)
      .set('Authorization', auth());

    expect(confirmed.status).toBe(503); // the transient abort error is indeterminate: nothing changes
    expect((await row(id)).processing_status).toBe('uploading');
    abortSpy.mockClear();
    const retried = await http()
      .delete(`/videos/${id}/upload`)
      .set('Authorization', auth());
    expect(retried.status).toBe(204);
    expect((await row(id)).processing_status).toBe('cancelled');
    expect(
      await ctx.storage.listMultipartUploads(originalKey((await row(id)).id)),
    ).toEqual([]);

    // ListParts never confirms NoSuchUpload: indeterminate, no transition, quota kept.
    const other = await startVideo();
    jest.spyOn(ctx.storage, 'listParts').mockResolvedValue([]);
    const stuck = await http()
      .delete(`/videos/${other}/upload`)
      .set('Authorization', auth());
    expect(stuck.status).toBe(503);
    expect((await row(other)).processing_status).toBe('uploading');
  });
});
