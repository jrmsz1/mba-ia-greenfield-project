import queueConfig from './queue.config';
import storageConfig from './storage.config';
import uploadConfig from './upload.config';
import workerConfig from './worker.config';

const PHASE_03_KEYS = [
  'S3_ENDPOINT',
  'S3_PUBLIC_ENDPOINT',
  'S3_BUCKET',
  'S3_FORCE_PATH_STYLE',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'MAX_UPLOAD_BYTES',
  'UPLOAD_PART_SIZE_BYTES',
  'PLAYBACK_PRESIGN_TTL_SECONDS',
  'MAX_PENDING_UPLOAD_BYTES_PER_OWNER',
  'WORKER_JOB_TIMEOUT_SECONDS',
  'PROCESSING_INPUT_PRESIGN_TTL_SECONDS',
  'PGBOSS_SCHEMA',
];

describe('phase 03 config factories', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of PHASE_03_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PHASE_03_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('should fall back to the documented defaults', () => {
    expect(storageConfig()).toMatchObject({
      endpoint: 'http://minio:9000',
      publicEndpoint: 'http://localhost:9000',
      bucket: 'streamtube-videos',
      forcePathStyle: true,
    });
    expect(uploadConfig()).toMatchObject({
      maxUploadBytes: 10_737_418_240,
      partSizeBytes: 67_108_864,
      playbackPresignTtlSeconds: 3600,
      maxPendingUploadBytesPerOwner: 21_474_836_480,
    });
    expect(workerConfig()).toMatchObject({
      jobTimeoutSeconds: 1800,
      processingInputPresignTtlSeconds: 3600,
    });
    expect(queueConfig()).toEqual({
      schema: 'pgboss',
      testSchema: 'pgboss_test',
    });
  });

  it('should read typed values from the environment', () => {
    process.env.S3_FORCE_PATH_STYLE = 'false';
    process.env.S3_ACCESS_KEY_ID = 'key';
    process.env.S3_SECRET_ACCESS_KEY = 'secret';
    process.env.MAX_UPLOAD_BYTES = '1048576';
    process.env.WORKER_JOB_TIMEOUT_SECONDS = '60';
    process.env.PGBOSS_SCHEMA = 'queue_jobs';

    expect(storageConfig()).toMatchObject({
      forcePathStyle: false,
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });
    expect(uploadConfig().maxUploadBytes).toBe(1_048_576);
    expect(workerConfig().jobTimeoutSeconds).toBe(60);
    expect(queueConfig().schema).toBe('queue_jobs');
  });
});
