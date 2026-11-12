/**
 * Verification Gate 6 — real ffprobe/ffmpeg (the worker image's pinned
 * FFmpeg) over real presigned GETs of the pinned MinIO test bucket. Fixtures
 * come from test/fixtures/media/generate.sh, run here into a temp directory.
 *
 * The API image is deliberately free of FFmpeg (phase-03-videos/TD-06), so
 * this suite runs in the worker container: `npm run test:media` (see
 * nestjs-project/CLAUDE.md). Elsewhere it is reported as skipped; with
 * MEDIA_TOOLS_REQUIRED=1 a missing ffprobe fails the run instead.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigType } from '@nestjs/config';
import workerConfig from '../config/worker.config';
import {
  buildS3Clients,
  destroyS3Clients,
  type S3Clients,
} from '../storage/s3-clients.provider';
import { StorageService } from '../storage/storage.service';
import { originalKey } from '../storage/storage-key';
import { testStorageConfig, verifyTestBucket } from '../test/test-storage';
import { FfmpegRunner } from './ffmpeg.runner';
import { FfprobeRunner } from './ffprobe.runner';
import { MediaToolError } from './media-errors';
import { JOB_TEMP_DIR_PREFIX } from './media.constants';
import { evaluateMedia } from './media-rule';
import { runTool } from './process-runner';
import { thumbnailPositionSeconds, withJobTempDir } from './thumbnail-policy';

jest.setTimeout(180_000);

const hasFfmpeg = spawnSync('ffprobe', ['-version']).status === 0;
if (!hasFfmpeg && process.env.MEDIA_TOOLS_REQUIRED === '1') {
  throw new Error('MEDIA_TOOLS_REQUIRED=1 but ffprobe is not installed here');
}
const describeMedia = hasFfmpeg ? describe : describe.skip;

const ACCEPTED = [
  'h264-aac-faststart.mp4',
  'h264-no-audio.mp4',
  'h264-aac-moov-at-end.mp4',
  'h264-brand-mp42.mp4',
  'h264-brand-mp41.mp4',
  'h264-brand-avc1.mp4',
  'h264-brand-iso2.mp4',
];
const REJECTED = [
  'mkv-saved-as.mp4',
  'quicktime.mov',
  'clip.3gp',
  'hevc.mp4',
  'vp9.webm',
  'h264-yuv444p.mp4',
  'h264-mp3-audio.mp4',
  'truncated.mp4',
  'random-bytes.mp4',
  'text.mp4',
];

describeMedia('media probe and thumbnail (Gate 6, real FFmpeg)', () => {
  let fixtures: string;
  let clients: S3Clients;
  let apiClients: S3Clients;
  let worker: ConfigType<typeof workerConfig>;
  let probe: FfprobeRunner;
  let ffmpeg: FfmpegRunner;
  const url = new Map<string, string>();

  const classify = async (name: string, maxDurationSeconds = 14_400) => {
    try {
      return evaluateMedia(await probe.probe(url.get(name) as string), {
        maxDurationSeconds,
      });
    } catch (error) {
      if (error instanceof MediaToolError && error.kind === 'permanent') {
        // The probe could not read it as media at all.
        return { accepted: false, reason: 'UNSUPPORTED_FORMAT' } as const;
      }
      throw error;
    }
  };

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), 'media-fixtures-'));
    const gen = await runTool(
      'sh',
      ['test/fixtures/media/generate.sh', fixtures],
      120_000,
    );
    expect(gen.code).toBe(0);

    // The worker reads (worker identity); fixtures are written as originals
    // by the restricted test API identity — the only one allowed to write
    // `videos/*/original` (TD-04). Each run uses fresh keys: no bucket reset.
    const config = testStorageConfig('worker');
    clients = buildS3Clients(config);
    const storage = new StorageService(clients, config);
    const apiConfig = testStorageConfig('api');
    apiClients = buildS3Clients(apiConfig);
    const writer = new StorageService(apiClients, apiConfig);
    await verifyTestBucket(clients.internal, config.bucket);
    for (const name of readdirSync(fixtures)) {
      const key = originalKey(randomUUID());
      await writer.putObject(
        key,
        await readFile(join(fixtures, name)),
        'application/octet-stream',
      );
      url.set(name, await storage.presignInternalGet(key, 900));
    }
    worker = { ...workerConfig(), mediaProbeTimeoutSeconds: 30 };
    probe = new FfprobeRunner(worker);
    ffmpeg = new FfmpegRunner(worker);
  });

  afterAll(async () => {
    destroyS3Clients(clients);
    destroyS3Clients(apiClients);
    await rm(fixtures, { recursive: true, force: true });
  });

  it.each(ACCEPTED)(
    'accepts %s with a positive duration and container/stream metadata',
    async (name) => {
      const verdict = await classify(name);

      expect(verdict.accepted).toBe(true);
      if (!verdict.accepted) return;
      expect(verdict.durationSeconds).toBeGreaterThan(0);
      expect(verdict.metadata).toMatchObject({
        format_name: expect.stringContaining('mp4') as string,
        video: {
          codec_name: 'h264',
          pix_fmt: 'yuv420p',
          width: 160,
          height: 120,
        },
      });
    },
  );

  it.each(REJECTED)('rejects %s as UNSUPPORTED_FORMAT', async (name) => {
    expect(await classify(name)).toMatchObject({
      accepted: false,
      reason: 'UNSUPPORTED_FORMAT',
    });
  });

  it('rejects an accepted 6 s clip as DURATION_LIMIT_EXCEEDED with a 5 s ceiling', async () => {
    expect(await classify('h264-6s.mp4', 5)).toMatchObject({
      accepted: false,
      reason: 'DURATION_LIMIT_EXCEEDED',
    });
    expect((await classify('h264-6s.mp4', 14_400)).accepted).toBe(true);
  });

  it('records that a truncated file with an intact header passes ffprobe (caught by the TD-02 size check / thumbnail decode)', async () => {
    const verdict = await classify('truncated-faststart.mp4');

    expect(verdict.accepted).toBe(true);
  });

  it('extracts a JPEG thumbnail at the policy position into a per-job dir that is removed afterwards', async () => {
    let dir = '';
    const jpeg = await withJobTempDir(async (jobDir) => {
      dir = jobDir;
      const out = join(jobDir, 'thumbnail.jpg');
      await ffmpeg.extractFrame(
        url.get('h264-aac-faststart.mp4') as string,
        thumbnailPositionSeconds(2),
        out,
      );
      return await readFile(out);
    });

    expect(jpeg.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(dir.includes(JOB_TEMP_DIR_PREFIX)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('removes the per-job dir after a failed probe', async () => {
    let dir = '';
    await expect(
      withJobTempDir(async (jobDir) => {
        dir = jobDir;
        return await probe.probe(url.get('text.mp4') as string);
      }),
    ).rejects.toBeInstanceOf(MediaToolError);

    expect(dir).not.toBe('');
    expect(existsSync(dir)).toBe(false);
  });

  it('classifies a tampered signature (403) as transient and never exposes the signed URL', async () => {
    const signed = url.get('h264-no-audio.mp4') as string;
    const tampered = signed.replace(
      /X-Amz-Signature=[0-9a-f]+/,
      'X-Amz-Signature=' + '0'.repeat(64),
    );

    const error = await probe.probe(tampered).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MediaToolError);
    expect((error as MediaToolError).kind).toBe('transient');
    expect((error as MediaToolError).message).not.toMatch(/X-Amz-/i);
    expect((error as MediaToolError).message).not.toContain(signed);
  });

  describe('timeout', () => {
    let server: Server;
    let stalled: string;

    beforeAll(async () => {
      // Accepts the request and never answers.
      server = createServer(() => undefined);
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const { port } = server.address() as { port: number };
      stalled = `http://127.0.0.1:${port}/videos/x/original?X-Amz-Signature=${'a'.repeat(64)}`;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    it('kills ffprobe after MEDIA_PROBE_TIMEOUT_SECONDS and classifies it as transient', async () => {
      const short = new FfprobeRunner({
        ...worker,
        mediaProbeTimeoutSeconds: 2,
      });
      const started = Date.now();

      const error = await short.probe(stalled).catch((e: unknown) => e);

      const elapsed = Date.now() - started;
      expect(error).toBeInstanceOf(MediaToolError);
      expect((error as MediaToolError).kind).toBe('transient');
      expect((error as MediaToolError).message).toContain('timed out');
      expect((error as MediaToolError).message).not.toMatch(/X-Amz-/i);
      expect(elapsed).toBeLessThan(5_000);
      // No ffprobe process survives the kill.
      const alive = await runTool(
        'sh',
        [
          '-c',
          'cat /proc/[0-9]*/comm 2>/dev/null | grep -c "^ffprobe$" || true',
        ],
        5_000,
      );
      expect(alive.stdout.trim()).toBe('0');
    });
  });
});
