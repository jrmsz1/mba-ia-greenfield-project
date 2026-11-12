import { Logger } from '@nestjs/common';
import { writeFile } from 'node:fs/promises';
import { MediaToolError } from '../media/media-errors';
import type { ProbeResult } from '../media/ffprobe.runner';
import {
  VideoProcessingWorker,
  type ProcessJob,
} from './video-processing.worker';

const VIDEO_ID = '0b1b0c4e-7d3a-4d2e-9c55-1f0e5d4c3b2a';
const SIZE = 1000;
const SIGNED = `http://minio:9000/b/videos/${VIDEO_ID}/original?X-Amz-Signature=${'f'.repeat(64)}`;

const H264_MP4: ProbeResult = {
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '2.0',
    size: String(SIZE),
    tags: { major_brand: 'isom' },
  },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      pix_fmt: 'yuv420p',
      width: 1,
      height: 1,
    },
  ],
};

/** Rows returned by the mocked dataSource.query, keyed by SQL shape. */
interface DbState {
  claimed: boolean;
  attempt: number;
  concludeApplies: boolean;
}

function setup(overrides: Partial<DbState> = {}) {
  const state: DbState = {
    claimed: true,
    attempt: 1,
    concludeApplies: true,
    ...overrides,
  };
  const queries: { sql: string; params: unknown[] }[] = [];
  const dataSource = {
    query: jest.fn((sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('SET "processing_status" = \'processing\'')) {
        return Promise.resolve(
          state.claimed
            ? [[{ processing_attempts: state.attempt }], 1]
            : [[], 0],
        );
      }
      if (sql.includes('SELECT "declared_size_bytes"')) {
        return Promise.resolve([{ declared_size_bytes: String(SIZE) }]);
      }
      return Promise.resolve(
        state.concludeApplies ? [[{ id: VIDEO_ID }], 1] : [[], 0],
      );
    }),
  };
  const storage = {
    headObject: jest.fn().mockResolvedValue({
      contentLength: SIZE,
      etag: '"e-1"',
      uploadBinding: 't',
    }),
    presignInternalGet: jest.fn().mockResolvedValue(SIGNED),
    putObject: jest.fn().mockResolvedValue(undefined),
  };
  const probe = { probe: jest.fn().mockResolvedValue(H264_MP4) };
  const ffmpeg = {
    extractFrame: jest.fn(async (_input: string, _at: number, out: string) => {
      await writeFile(out, Buffer.from([0xff, 0xd8, 0xff]));
    }),
  };
  const worker = new VideoProcessingWorker(
    {} as never,
    dataSource as never,
    storage as never,
    probe as never,
    ffmpeg as never,
    {
      concurrency: 1,
      jobTimeoutSeconds: 1800,
      mediaProbeTimeoutSeconds: 120,
      maxVideoDurationSeconds: 14_400,
      processingInputPresignTtlSeconds: 3600,
    },
  );
  const job = (retryCount = 0, retryLimit = 3): ProcessJob => ({
    id: 'job-1',
    data: { videoId: VIDEO_ID },
    retryCount,
    retryLimit,
  });
  const concludedWith = (status: string) =>
    queries.find(
      (q) =>
        q.sql.includes(`"processing_status" = '${status}'`) &&
        !q.sql.includes('IN ('),
    );
  return {
    worker,
    job,
    dataSource,
    storage,
    probe,
    ffmpeg,
    queries,
    concludedWith,
  };
}

describe('VideoProcessingWorker', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown) => {
          logs.push(String(message));
        });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('processes a valid video to ready, fenced on its own attempt', async () => {
    const t = setup({ attempt: 2 });

    expect(await t.worker.process(t.job())).toBe('ready');

    const ready = t.concludedWith('ready');
    expect(ready?.sql).toContain('"processing_attempts" = $2');
    expect(ready?.params.slice(0, 3)).toEqual([VIDEO_ID, 2, 2]);
    expect(t.storage.putObject).toHaveBeenCalledWith(
      `videos/${VIDEO_ID}/thumbnail.jpg`,
      expect.any(Buffer),
      'image/jpeg',
    );
  });

  it('skips a duplicate or late delivery (row not uploaded/processing) without touching storage', async () => {
    const t = setup({ claimed: false });

    expect(await t.worker.process(t.job())).toBe('skipped');
    expect(t.storage.headObject).not.toHaveBeenCalled();
    expect(t.probe.probe).not.toHaveBeenCalled();
  });

  it('never runs the probe when the original is missing, and fails without retry', async () => {
    const t = setup();
    t.storage.headObject.mockResolvedValue(null);

    expect(await t.worker.process(t.job())).toBe('failed');
    expect(t.probe.probe).not.toHaveBeenCalled();
    expect(t.storage.presignInternalGet).not.toHaveBeenCalled();
    expect(t.concludedWith('failed')?.params).toEqual([
      VIDEO_ID,
      1,
      'PROCESSING_FAILED',
    ]);
  });

  it('fails a permanent probe error as UNSUPPORTED_FORMAT without retrying', async () => {
    const t = setup();
    t.probe.probe.mockRejectedValue(
      new MediaToolError('permanent', 'ffprobe', 'Invalid data found'),
    );

    expect(await t.worker.process(t.job())).toBe('failed');
    expect(t.concludedWith('failed')?.params[2]).toBe('UNSUPPORTED_FORMAT');
  });

  it('fails an accepted format over the ceiling as DURATION_LIMIT_EXCEEDED', async () => {
    const t = setup();
    t.probe.probe.mockResolvedValue({
      ...H264_MP4,
      format: { ...H264_MP4.format, duration: '99999' },
    });

    expect(await t.worker.process(t.job())).toBe('failed');
    expect(t.concludedWith('failed')?.params[2]).toBe(
      'DURATION_LIMIT_EXCEEDED',
    );
    expect(t.ffmpeg.extractFrame).not.toHaveBeenCalled();
  });

  it('rethrows a transient error with retries left, redacted, without changing the row', async () => {
    const t = setup();
    t.probe.probe.mockRejectedValue(
      new MediaToolError(
        'transient',
        'ffprobe',
        `${SIGNED}: Server returned 503`,
      ),
    );

    const error = await t.worker.process(t.job(0, 3)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/X-Amz-/i);
    expect(t.concludedWith('failed')).toBeUndefined();
    expect(t.concludedWith('ready')).toBeUndefined();
  });

  it('marks PROCESSING_FAILED when retries are exhausted and completes the job', async () => {
    const t = setup({ attempt: 4 });
    t.probe.probe.mockRejectedValue(
      new MediaToolError('transient', 'ffprobe', 'Connection refused'),
    );

    expect(await t.worker.process(t.job(3, 3))).toBe('failed');
    expect(t.concludedWith('failed')?.params).toEqual([
      VIDEO_ID,
      4,
      'PROCESSING_FAILED',
    ]);
  });

  it('a stale attempt that was re-claimed meanwhile cannot conclude the video', async () => {
    const t = setup({ concludeApplies: false });

    expect(await t.worker.process(t.job())).toBe('superseded');
  });

  it('never logs or persists a presigned URL or X-Amz parameter', async () => {
    const t = setup();
    t.probe.probe.mockRejectedValue(
      new MediaToolError('permanent', 'ffprobe', `${SIGNED}: Invalid data`),
    );

    await t.worker.process(t.job());

    for (const line of logs) expect(line).not.toMatch(/X-Amz-|Signature=/i);
    for (const q of t.queries) {
      for (const p of q.params) expect(String(p)).not.toMatch(/X-Amz-/i);
    }
  });
});
