/**
 * Phase 03 environment defaults — the single source used by the Joi schema
 * (env.validation.ts) and by the registerAs factories. Values come from the
 * phase-03-videos plan, SI-03.2 "Defaults operacionais"; every one of them is
 * overridable through the environment (phase-03-videos/TD-16).
 */
export const VIDEO_ENV_DEFAULTS = {
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'streamtube-videos',
  S3_TEST_BUCKET: 'streamtube-videos-test',
  S3_FORCE_PATH_STYLE: 'true',
  MINIO_API_CORS_ALLOW_ORIGIN: 'http://localhost:3001',
  MAX_UPLOAD_BYTES: 10_737_418_240,
  UPLOAD_PART_SIZE_BYTES: 67_108_864,
  UPLOAD_EXPIRY_HOURS: 24,
  UPLOAD_PART_PRESIGN_TTL_SECONDS: 900,
  PLAYBACK_PRESIGN_TTL_SECONDS: 3600,
  DOWNLOAD_PRESIGN_TTL_SECONDS: 900,
  PROCESSING_INPUT_PRESIGN_TTL_SECONDS: 3600,
  COMPLETING_STALE_MINUTES: 15,
  MAX_ACTIVE_UPLOADS_PER_OWNER: 3,
  MAX_PENDING_UPLOAD_BYTES_PER_OWNER: 21_474_836_480,
  WORKER_CONCURRENCY: 1,
  WORKER_JOB_TIMEOUT_SECONDS: 1800,
  MEDIA_PROBE_TIMEOUT_SECONDS: 120,
  MAX_VIDEO_DURATION_SECONDS: 14_400,
  PGBOSS_SCHEMA: 'pgboss',
  PGBOSS_TEST_SCHEMA: 'pgboss_test',
} as const;

/** Storage and SigV4 limits (phase-03-videos/TD-01, TD-04). */
export const S3_LIMITS = {
  MIN_PART_SIZE_BYTES: 5_242_880,
  MAX_PARTS: 10_000,
  MAX_PRESIGN_TTL_SECONDS: 604_800,
} as const;

/** Test isolation name rules, mirroring DB_TEST_NAME (phase-03-videos/TD-15). */
export const TEST_RESOURCE_PATTERNS = {
  S3_BUCKET: /^[a-z0-9-]+-test$/,
  PGBOSS_SCHEMA: /^[a-z][a-z0-9_]*_test$/,
} as const;

export function envInt(name: keyof typeof VIDEO_ENV_DEFAULTS): number {
  const raw = process.env[name];
  const fallback = VIDEO_ENV_DEFAULTS[name];
  return raw !== undefined && raw !== '' ? Number(raw) : Number(fallback);
}

export function envString(name: keyof typeof VIDEO_ENV_DEFAULTS): string {
  const raw = process.env[name];
  return raw !== undefined && raw !== ''
    ? raw
    : String(VIDEO_ENV_DEFAULTS[name]);
}
