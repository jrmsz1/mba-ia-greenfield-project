import {
  envValidationSchema,
  workerEnvValidationSchema,
} from './env.validation';
import { VIDEO_ENV_DEFAULTS } from './video.constants';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
  S3_DELIVERY_ACCESS_KEY_ID: 'delivery-key',
  S3_DELIVERY_SECRET_ACCESS_KEY: 'delivery-secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — phase 03 keys', () => {
  it('should apply every phase 03 default when only the credentials are set', () => {
    const result = validate({});
    const value = result.value as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    for (const [key, fallback] of Object.entries(VIDEO_ENV_DEFAULTS)) {
      expect(value).toHaveProperty(key, fallback);
    }
  });

  it.each([
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_DELIVERY_ACCESS_KEY_ID',
    'S3_DELIVERY_SECRET_ACCESS_KEY',
  ])('should require the API credential %s', (key) => {
    const env: Record<string, string> = { ...requiredEnv };
    delete env[key];

    const { error } = envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });

    expect(error?.message).toContain(key);
  });

  describe('per-process storage credentials (TD-16 revision 2026-11-12)', () => {
    it('should accept the API and the worker environments without MINIO_ROOT_*', () => {
      const workerEnv: Record<string, string> = { ...requiredEnv };
      delete workerEnv.S3_DELIVERY_ACCESS_KEY_ID;
      delete workerEnv.S3_DELIVERY_SECRET_ACCESS_KEY;

      expect(validate({}).error).toBeUndefined();
      expect(
        workerEnvValidationSchema.validate(workerEnv, { allowUnknown: true })
          .error,
      ).toBeUndefined();
    });

    it('should reject a delivery identity equal to the API identity', () => {
      const { error } = validate({ S3_DELIVERY_ACCESS_KEY_ID: 'access-key' });

      expect(error?.message).toContain('S3_DELIVERY_ACCESS_KEY_ID');
    });

    it('should forbid the delivery identity in the worker', () => {
      const { error } = workerEnvValidationSchema.validate(requiredEnv, {
        allowUnknown: true,
        abortEarly: false,
      });

      expect(error?.message).toContain('S3_DELIVERY_ACCESS_KEY_ID');
    });

    it.each([envValidationSchema, workerEnvValidationSchema])(
      'should not fall back to the test identities when S3_ACCESS_KEY_ID is missing',
      (schema) => {
        const env: Record<string, string> = {
          ...requiredEnv,
          S3_TEST_API_ACCESS_KEY_ID: 'test-api-key',
          S3_TEST_API_SECRET_ACCESS_KEY: 'test-api-secret',
        };
        delete env.S3_ACCESS_KEY_ID;
        if (schema === workerEnvValidationSchema) {
          delete env.S3_DELIVERY_ACCESS_KEY_ID;
          delete env.S3_DELIVERY_SECRET_ACCESS_KEY;
        }

        const { error } = schema.validate(env, {
          allowUnknown: true,
          abortEarly: false,
        });

        expect(error?.message).toContain('S3_ACCESS_KEY_ID');
      },
    );
  });

  it('should reject a processing input TTL that does not exceed the job timeout', () => {
    const { error } = validate({
      PROCESSING_INPUT_PRESIGN_TTL_SECONDS: '1800',
      WORKER_JOB_TIMEOUT_SECONDS: '1800',
    });

    expect(error?.message).toContain('PROCESSING_INPUT_PRESIGN_TTL_SECONDS');
    expect(error?.message).toContain('WORKER_JOB_TIMEOUT_SECONDS');
  });

  it.each([
    'UPLOAD_PART_PRESIGN_TTL_SECONDS',
    'PLAYBACK_PRESIGN_TTL_SECONDS',
    'DOWNLOAD_PRESIGN_TTL_SECONDS',
    'PROCESSING_INPUT_PRESIGN_TTL_SECONDS',
  ])('should reject %s above the SigV4 limit of 604800 seconds', (key) => {
    const { error } = validate({ [key]: '604801' });

    expect(error?.message).toContain(key);
  });

  it('should reject a part size below 5 MiB', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '5242879' });

    expect(error?.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });

  it('should reject a size limit that needs more than 10000 parts', () => {
    const { error } = validate({
      MAX_UPLOAD_BYTES: String(5_242_880 * 10_001),
      UPLOAD_PART_SIZE_BYTES: '5242880',
      MAX_PENDING_UPLOAD_BYTES_PER_OWNER: String(5_242_880 * 10_001),
    });

    expect(error?.message).toContain('10000 parts');
  });

  it('should reject a pending-bytes quota smaller than the upload limit', () => {
    const { error } = validate({
      MAX_UPLOAD_BYTES: '20000000',
      MAX_PENDING_UPLOAD_BYTES_PER_OWNER: '10000000',
    });

    expect(error?.message).toContain('MAX_PENDING_UPLOAD_BYTES_PER_OWNER');
  });

  it('should reject a test bucket without the -test suffix', () => {
    const { error } = validate({ S3_TEST_BUCKET: 'streamtube-videos' });

    expect(error?.message).toContain('S3_TEST_BUCKET');
  });

  it('should reject a test queue schema without the _test suffix', () => {
    const { error } = validate({ PGBOSS_TEST_SCHEMA: 'pgboss' });

    expect(error?.message).toContain('PGBOSS_TEST_SCHEMA');
  });
});
