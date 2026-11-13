import {
  envValidationSchema,
  PUBLIC_JWT_PLACEHOLDERS,
  workerEnvValidationSchema,
} from './env.validation';
import { VIDEO_ENV_DEFAULTS } from './video.constants';

// Fictitious values with the shape the setup scripts generate.
const ACCESS_SECRET = 'fixture-access-jwt-0123456789abcdefghijklmnopqrstuv';
const REFRESH_SECRET = 'fixture-refresh-jwt-0123456789abcdefghijklmnopqrstu';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: ACCESS_SECRET,
  JWT_REFRESH_SECRET: REFRESH_SECRET,
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

    it.each([
      'MINIO_ROOT_USER',
      'MINIO_ROOT_PASSWORD',
      'S3_TEST_MAINTENANCE_ACCESS_KEY_ID',
      'S3_TEST_MAINTENANCE_SECRET_ACCESS_KEY',
    ])(
      'should refuse %s in the API and the worker (no root, no maintenance)',
      (key) => {
        const workerEnv: Record<string, string> = {
          ...requiredEnv,
          [key]: 'x',
        };
        delete workerEnv.S3_DELIVERY_ACCESS_KEY_ID;
        delete workerEnv.S3_DELIVERY_SECRET_ACCESS_KEY;
        const opts = { allowUnknown: true, abortEarly: false };

        expect(validate({ [key]: 'x' }).error?.message).toContain(key);
        expect(
          workerEnvValidationSchema.validate(workerEnv, opts).error?.message,
        ).toContain(key);
      },
    );

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

describe('envValidationSchema — JWT secrets (fail closed)', () => {
  it('should accept two distinct secrets with the generated shape (64 hex characters)', () => {
    const { error } = validate({
      JWT_SECRET: 'a3f1'.repeat(4) + '0b9c7d2e5f6a8b1c'.repeat(3),
      JWT_REFRESH_SECRET: '7e2d'.repeat(4) + 'c4b5a69788f1e0d3'.repeat(3),
    });

    expect(error).toBeUndefined();
  });

  it.each(['JWT_SECRET', 'JWT_REFRESH_SECRET'])(
    'should refuse a missing %s',
    (key) => {
      const env: Record<string, string> = { ...requiredEnv };
      delete env[key];

      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
      });

      expect(error?.message).toContain(key);
    },
  );

  it.each(['JWT_SECRET', 'JWT_REFRESH_SECRET'])(
    'should refuse an empty %s',
    (key) => {
      expect(validate({ [key]: '' }).error?.message).toContain(key);
    },
  );

  it.each(
    PUBLIC_JWT_PLACEHOLDERS.flatMap((placeholder) => [
      ['JWT_SECRET', placeholder],
      ['JWT_REFRESH_SECRET', placeholder],
    ]),
  )('should refuse %s set to the public placeholder %s', (key, value) => {
    const { error } = validate({ [key]: value });

    expect(error?.message).toContain(key);
    expect(error?.message).toContain('public placeholder');
  });

  it('should refuse a long value that still reads as a placeholder', () => {
    const { error } = validate({
      JWT_SECRET: 'please-change-me-before-going-live-0123456789',
    });

    expect(error?.message).toContain('public placeholder');
  });

  it('should refuse a secret shorter than 32 characters', () => {
    const { error } = validate({ JWT_SECRET: 'Xk29fQ0pL7mZ3vB8nC1d' });

    expect(error?.message).toContain('JWT_SECRET');
    expect(error?.message).toContain('at least 32 characters');
  });

  it('should refuse a long but repetitive secret', () => {
    const { error } = validate({ JWT_REFRESH_SECRET: 'ab'.repeat(32) });

    expect(error?.message).toContain('JWT_REFRESH_SECRET');
    expect(error?.message).toContain('too repetitive');
  });

  it('should refuse the same value for the access and the refresh secret', () => {
    const { error } = validate({ JWT_REFRESH_SECRET: ACCESS_SECRET });

    expect(error?.message).toContain(
      'JWT_REFRESH_SECRET must differ from JWT_SECRET',
    );
  });

  it('should never echo a rejected value in the error message', () => {
    const shortSecret = 'Xk29fQ0pL7mZ3vB8nC1d';
    const { error } = validate({
      JWT_SECRET: shortSecret,
      JWT_REFRESH_SECRET: 'ab'.repeat(32),
    });

    expect(error).toBeDefined();
    expect(error?.message).not.toContain(shortSecret);
    expect(error?.message).not.toContain('ab'.repeat(32));
  });

  it('should leave the worker schema unchanged (the worker signs no token)', () => {
    const { error } = workerEnvValidationSchema.validate(
      {
        ...requiredEnv,
        JWT_SECRET: 'change-me-in-production',
        S3_DELIVERY_ACCESS_KEY_ID: undefined,
        S3_DELIVERY_SECRET_ACCESS_KEY: undefined,
      },
      { allowUnknown: true },
    );

    expect(error).toBeUndefined();
  });
});
