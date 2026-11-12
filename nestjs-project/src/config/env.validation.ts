import * as Joi from 'joi';
import {
  S3_LIMITS,
  TEST_RESOURCE_PATTERNS,
  VIDEO_ENV_DEFAULTS as D,
} from './video.constants';

const positiveInt = () => Joi.number().integer().positive();
const presignTtl = (fallback: number) =>
  positiveInt().max(S3_LIMITS.MAX_PRESIGN_TTL_SECONDS).default(fallback);

/** Phase 03 keys (phase-03-videos/TD-16 canonical list). */
const videoKeys = {
  S3_ENDPOINT: Joi.string().uri().default(D.S3_ENDPOINT),
  S3_PUBLIC_ENDPOINT: Joi.string().uri().default(D.S3_PUBLIC_ENDPOINT),
  S3_REGION: Joi.string().default(D.S3_REGION),
  S3_BUCKET: Joi.string().default(D.S3_BUCKET),
  S3_TEST_BUCKET: Joi.string()
    .pattern(TEST_RESOURCE_PATTERNS.S3_BUCKET)
    .default(D.S3_TEST_BUCKET),
  // The process's own storage identity (API or worker), never the MinIO root
  // user, which only the minio service and the provisioning container receive
  // (phase-03-videos/TD-04, TD-16 revisions 2026-11-12). No fallback: the
  // S3_TEST_* identities are mapped only by the test setup (src/test).
  S3_ACCESS_KEY_ID: Joi.string().required(),
  S3_SECRET_ACCESS_KEY: Joi.string().required(),
  S3_FORCE_PATH_STYLE: Joi.string()
    .valid('true', 'false')
    .default(D.S3_FORCE_PATH_STYLE),
  MINIO_API_CORS_ALLOW_ORIGIN: Joi.string().default(
    D.MINIO_API_CORS_ALLOW_ORIGIN,
  ),
  MAX_UPLOAD_BYTES: positiveInt().default(D.MAX_UPLOAD_BYTES),
  UPLOAD_PART_SIZE_BYTES: positiveInt()
    .min(S3_LIMITS.MIN_PART_SIZE_BYTES)
    .default(D.UPLOAD_PART_SIZE_BYTES),
  UPLOAD_EXPIRY_HOURS: positiveInt().default(D.UPLOAD_EXPIRY_HOURS),
  UPLOAD_PART_PRESIGN_TTL_SECONDS: presignTtl(
    D.UPLOAD_PART_PRESIGN_TTL_SECONDS,
  ),
  PLAYBACK_PRESIGN_TTL_SECONDS: presignTtl(D.PLAYBACK_PRESIGN_TTL_SECONDS),
  DOWNLOAD_PRESIGN_TTL_SECONDS: presignTtl(D.DOWNLOAD_PRESIGN_TTL_SECONDS),
  PROCESSING_INPUT_PRESIGN_TTL_SECONDS: presignTtl(
    D.PROCESSING_INPUT_PRESIGN_TTL_SECONDS,
  ),
  COMPLETING_STALE_MINUTES: positiveInt().default(D.COMPLETING_STALE_MINUTES),
  MAX_ACTIVE_UPLOADS_PER_OWNER: positiveInt().default(
    D.MAX_ACTIVE_UPLOADS_PER_OWNER,
  ),
  MAX_PENDING_UPLOAD_BYTES_PER_OWNER: positiveInt().default(
    D.MAX_PENDING_UPLOAD_BYTES_PER_OWNER,
  ),
  WORKER_CONCURRENCY: positiveInt().default(D.WORKER_CONCURRENCY),
  WORKER_JOB_TIMEOUT_SECONDS: positiveInt().default(
    D.WORKER_JOB_TIMEOUT_SECONDS,
  ),
  MEDIA_PROBE_TIMEOUT_SECONDS: positiveInt().default(
    D.MEDIA_PROBE_TIMEOUT_SECONDS,
  ),
  MAX_VIDEO_DURATION_SECONDS: positiveInt().default(
    D.MAX_VIDEO_DURATION_SECONDS,
  ),
  PGBOSS_SCHEMA: Joi.string()
    .pattern(/^[a-z][a-z0-9_]*$/)
    .default(D.PGBOSS_SCHEMA),
  PGBOSS_TEST_SCHEMA: Joi.string()
    .pattern(TEST_RESOURCE_PATTERNS.PGBOSS_SCHEMA)
    .default(D.PGBOSS_TEST_SCHEMA),
};

/**
 * Rules that relate two keys (phase-03-videos/TD-01, TD-08 revision AMB-3,
 * TD-13). Each message names the keys involved.
 */
function crossKeyRules(
  env: Record<string, number>,
  helpers: Joi.CustomHelpers,
): Record<string, number> | Joi.ErrorReport {
  const fail = (message: string) =>
    helpers.error('any.custom', { error: new Error(message) });
  if (
    env.PROCESSING_INPUT_PRESIGN_TTL_SECONDS <= env.WORKER_JOB_TIMEOUT_SECONDS
  ) {
    return fail(
      'PROCESSING_INPUT_PRESIGN_TTL_SECONDS must be greater than WORKER_JOB_TIMEOUT_SECONDS',
    );
  }
  if (
    Math.ceil(env.MAX_UPLOAD_BYTES / env.UPLOAD_PART_SIZE_BYTES) >
    S3_LIMITS.MAX_PARTS
  ) {
    return fail(
      `MAX_UPLOAD_BYTES / UPLOAD_PART_SIZE_BYTES must not exceed ${S3_LIMITS.MAX_PARTS} parts`,
    );
  }
  if (env.MAX_PENDING_UPLOAD_BYTES_PER_OWNER < env.MAX_UPLOAD_BYTES) {
    return fail(
      'MAX_PENDING_UPLOAD_BYTES_PER_OWNER must be greater than or equal to MAX_UPLOAD_BYTES',
    );
  }
  return env;
}

const baseEnvKeys = {
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  ...videoKeys,
};

/**
 * The API also holds the read-only delivery identity that signs playback and
 * download URLs (phase-03-videos/TD-04 revision 2026-11-12): both halves are
 * required and the identity must differ from the API's own.
 */
function distinctDeliveryIdentity(
  env: Record<string, string>,
  helpers: Joi.CustomHelpers,
): Record<string, string> | Joi.ErrorReport {
  if (env.S3_DELIVERY_ACCESS_KEY_ID === env.S3_ACCESS_KEY_ID) {
    return helpers.error('any.custom', {
      error: new Error(
        'S3_DELIVERY_ACCESS_KEY_ID must differ from S3_ACCESS_KEY_ID (separate delivery identity)',
      ),
    });
  }
  return env;
}

/** HTTP API process (AppModule). */
export const envValidationSchema = Joi.object({
  ...baseEnvKeys,
  S3_DELIVERY_ACCESS_KEY_ID: Joi.string().required(),
  S3_DELIVERY_SECRET_ACCESS_KEY: Joi.string().required(),
})
  .custom(crossKeyRules, 'phase 03 cross-key rules')
  .custom(distinctDeliveryIdentity, 'separate delivery identity');

/**
 * Video worker process (WorkerModule): it signs no client URL, so it must not
 * receive the delivery identity (phase-03-videos/TD-16 revision 2026-11-12).
 */
export const workerEnvValidationSchema = Joi.object({
  ...baseEnvKeys,
  S3_DELIVERY_ACCESS_KEY_ID: Joi.forbidden(),
  S3_DELIVERY_SECRET_ACCESS_KEY: Joi.forbidden(),
}).custom(crossKeyRules, 'phase 03 cross-key rules');
