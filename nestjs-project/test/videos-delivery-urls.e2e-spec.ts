/**
 * E2E for SI-03.16 — authored from nestjs-project/specs/videos-delivery-urls.plan.md
 * (one test per scenario, scenario ids in the test names), plus negative
 * access and log-hygiene checks. Range/expiry are exercised with plain HTTP
 * against the URLs the API emits, on the real Compose MinIO.
 *
 * The stored object is random bytes, not a media fixture: delivery never
 * inspects content (real-media validity is Gate 6), and the API container
 * has no FFmpeg to generate one (TD-06).
 */
import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import storageConfig from '../src/config/storage.config';
import { originalKey } from '../src/storage/storage-key';
import { fetchPresigned } from '../src/test/test-storage';
import { buildVideoValues } from '../src/test/video-fixtures';
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

const SIZE = 64 * 1024;

describe('videos-delivery-urls', () => {
  let ctx: VideosE2e;
  let owner: E2eUser;
  let defaultPlaybackTtl: number;
  let logs: string[];

  const http = () => request(ctx.app.getHttpServer());
  const auth = (token = owner.token) => `Bearer ${token}`;
  const get = (path: string, token?: string) =>
    http().get(path).set('Authorization', auth(token));

  /** A `ready` video of the owner with its original stored in the test bucket. */
  const readyVideo = async (): Promise<{ id: string; uuid: string }> => {
    const video = await ctx.dataSource.getRepository(Video).save(
      ctx.dataSource.getRepository(Video).create({
        public_id: randomBytes(8).toString('hex').slice(0, 11),
        ...buildVideoValues(owner.channel.id, {
          processing_status: 'ready',
          declared_size_bytes: SIZE,
          original_filename: 'Meu vídeo.mp4',
        }),
      }),
    );
    await ctx.storage.putObject(
      originalKey(video.id),
      randomBytes(SIZE),
      'video/mp4',
    );
    return { id: video.public_id, uuid: video.id };
  };

  /**
   * AC #1 (revised 2026-11-12): no secret key, admin token or other permanent
   * secret anywhere in the response; S3_ACCESS_KEY_ID only inside the
   * X-Amz-Credential parameter of the presigned URL (AWS SigV4).
   */
  const expectNoPermanentCredentials = (res: {
    text: string;
    body: unknown;
  }): void => {
    const { accessKeyId, secretAccessKey } = storageConfig();
    const rootPassword = process.env.MINIO_ROOT_PASSWORD ?? '';
    // Exactly these two properties; expires_at is a plain ISO date.
    expect(Object.keys(res.body as object).sort()).toEqual([
      'expires_at',
      'url',
    ]);
    const expiresAt = bodyField(res, 'expires_at') as string;
    expect(new Date(expiresAt).toISOString()).toBe(expiresAt);
    expect(secretAccessKey.length).toBeGreaterThan(0);
    expect(res.text).not.toContain(secretAccessKey);
    if (rootPassword) expect(res.text).not.toContain(rootPassword);
    expect(res.text).not.toContain(owner.token);
    expect(res.text).not.toMatch(/X-Amz-Security-Token/i);
    const url = new URL(bodyField(res, 'url') as string);
    expect(
      url.searchParams.get('X-Amz-Credential')?.startsWith(`${accessKeyId}/`),
    ).toBe(true);
    expect(
      res.text.replace(/X-Amz-Credential=[^&"]+/, 'X-Amz-Credential=…'),
    ).not.toContain(accessKeyId);
  };

  beforeAll(async () => {
    ctx = await createVideosApp();
    defaultPlaybackTtl = ctx.upload.playbackPresignTtlSeconds;
  });

  afterAll(async () => {
    ctx.upload.playbackPresignTtlSeconds = defaultPlaybackTtl;
    await closeVideosApp(ctx);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    ctx.upload.playbackPresignTtlSeconds = defaultPlaybackTtl;
    logs = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logs.push(args.map(String).join(' '));
        });
    }
    await resetVideosState(ctx);
    owner = await createLoggedInOwner(ctx);
  });

  afterEach(() => {
    for (const line of logs) expect(line).not.toMatch(/X-Amz-|Signature=/i);
  });

  // 1. Emissão e uso das URLs

  it('1.1 owner-gets-playback-url', async () => {
    const { id } = await readyVideo();
    const { publicEndpoint } = storageConfig();

    const res = await get(`/videos/${id}/playback-url`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body as object).sort()).toEqual([
      'expires_at',
      'url',
    ]);
    const url = bodyField(res, 'url') as string;
    expect(new URL(url).host).toBe(new URL(publicEndpoint).host);
    expect(Date.parse(bodyField(res, 'expires_at') as string)).toBeGreaterThan(
      Date.now(),
    );
    expectNoPermanentCredentials(res);
  });

  it('1.2 range-request-served-by-storage', async () => {
    const { id } = await readyVideo();
    const url = bodyField(
      await get(`/videos/${id}/playback-url`),
      'url',
    ) as string;

    const ranged = await fetchPresigned(url, {
      headers: { range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-range']).toBe(`bytes 0-1023/${SIZE}`);
    expect(ranged.headers['content-length']).toBe('1024');
    expect(ranged.headers['accept-ranges']).toBe('bytes');

    const unsatisfiable = await fetchPresigned(url, {
      headers: { range: `bytes=${SIZE + 10}-` },
    });
    expect(unsatisfiable.status).toBe(416);

    const unsigned = await fetchPresigned(url.split('?')[0]);
    expect(unsigned.status).toBe(403);
  });

  it('1.3 expiry-and-renewal', async () => {
    const { id } = await readyVideo();
    ctx.upload.playbackPresignTtlSeconds = 2; // test-only override
    const first = await get(`/videos/${id}/playback-url`);
    const url = bodyField(first, 'url') as string;
    expect(
      (await fetchPresigned(url, { headers: { range: 'bytes=0-1023' } }))
        .status,
    ).toBe(206);

    const expiresAt = Date.parse(bodyField(first, 'expires_at') as string);
    await new Promise((r) => setTimeout(r, expiresAt - Date.now() + 1500));
    expect(
      (await fetchPresigned(url, { headers: { range: 'bytes=1024-2047' } }))
        .status,
    ).toBe(403);

    const renewed = bodyField(
      await get(`/videos/${id}/playback-url`),
      'url',
    ) as string;
    const resumed = await fetchPresigned(renewed, {
      headers: { range: 'bytes=1024-2047' },
    });
    expect(resumed.status).toBe(206);
    expect(resumed.headers['content-range']).toBe(`bytes 1024-2047/${SIZE}`);
  });

  it('1.4 download-url-forces-attachment', async () => {
    const { id } = await readyVideo();

    const res = await get(`/videos/${id}/download-url`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expectNoPermanentCredentials(res);
    const stored = await fetchPresigned(bodyField(res, 'url') as string, {
      headers: { range: 'bytes=0-15' },
    });
    expect(stored.headers['content-disposition']).toContain('attachment');
    expect(stored.headers['content-disposition']).toContain(
      "filename*=UTF-8''Meu%20v%C3%ADdeo.mp4",
    );
  });

  // 2. Recusas e limites

  it('2.1 not-ready-and-not-owner', async () => {
    const { id, uuid } = await readyVideo();
    await ctx.dataSource.query(
      `UPDATE "videos" SET "processing_status" = 'processing' WHERE id = $1`,
      [uuid],
    );
    for (const route of ['playback-url', 'download-url']) {
      const res = await get(`/videos/${id}/${route}`);
      expect(res.status).toBe(409);
      expect(bodyField(res, 'error')).toBe('VIDEO_NOT_READY');
    }

    await ctx.dataSource.query(
      `UPDATE "videos" SET "processing_status" = 'ready' WHERE id = $1`,
      [uuid],
    );
    const other = await createLoggedInOwner(ctx);
    for (const route of ['playback-url', 'download-url']) {
      const res = await get(`/videos/${id}/${route}`, other.token);
      expect(res.status).toBe(404);
      expect(bodyField(res, 'error')).toBe('VIDEO_NOT_FOUND');
      expect(res.text).not.toMatch(/X-Amz-|https?:\/\//);
    }
  });

  it('2.2 delivery-url-cap-and-window-reset', async () => {
    const { id, uuid } = await readyVideo();
    for (let i = 0; i < 60; i++) {
      const route = i % 2 === 0 ? 'playback-url' : 'download-url';
      expect((await get(`/videos/${id}/${route}`)).status).toBe(200);
    }

    const blocked = await get(`/videos/${id}/playback-url`);
    expect(blocked.status).toBe(429);
    expect(bodyField(blocked, 'error')).toBe('DELIVERY_URL_LIMIT_EXCEEDED');

    await ctx.dataSource.query(
      `UPDATE "videos" SET "delivery_window_started_at" = now() - interval '61 minutes' WHERE id = $1`,
      [uuid],
    );
    expect((await get(`/videos/${id}/download-url`)).status).toBe(200);
  });

  // Extra negative checks (review requirements)

  it('refuses both routes without authentication (401) and for an unknown id (404)', async () => {
    const { id } = await readyVideo();
    for (const route of ['playback-url', 'download-url']) {
      expect((await http().get(`/videos/${id}/${route}`)).status).toBe(401);
      const unknown = await get(`/videos/zzzzzzzzzzz/${route}`);
      expect(unknown.status).toBe(404);
      expect(bodyField(unknown, 'error')).toBe('VIDEO_NOT_FOUND');
    }
  });

  it('renewing a URL keeps the same authorization: the other user still gets 404 after the owner renews', async () => {
    const { id } = await readyVideo();
    const other = await createLoggedInOwner(ctx);
    expect((await get(`/videos/${id}/playback-url`)).status).toBe(200);
    expect((await get(`/videos/${id}/playback-url`)).status).toBe(200);

    expect((await get(`/videos/${id}/playback-url`, other.token)).status).toBe(
      404,
    );
  });
});
