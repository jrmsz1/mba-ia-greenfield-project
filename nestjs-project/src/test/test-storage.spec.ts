import {
  applyTestStorageEnv,
  assertTestBucket,
  readTestStorageTarget,
  testWorkerProcessEnv,
  TestStorageGuardError,
} from './test-storage';

describe('assertTestBucket', () => {
  it.each(['streamtube-videos', 'videos-test-data', 'Bucket-test', ''])(
    'should refuse the non-test bucket "%s"',
    (bucket) => {
      expect(() => assertTestBucket(bucket)).toThrow(TestStorageGuardError);
    },
  );

  it('should accept a bucket ending with -test', () => {
    expect(() => assertTestBucket('streamtube-videos-test')).not.toThrow();
  });
});

/** A complete, valid test environment (fictitious identities). */
const testEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  S3_BUCKET: 'streamtube-videos',
  S3_TEST_BUCKET: 'streamtube-videos-test',
  S3_ACCESS_KEY_ID: 'prod-api-id',
  S3_SECRET_ACCESS_KEY: 'prod-api-secret',
  S3_DELIVERY_ACCESS_KEY_ID: 'prod-delivery-id',
  S3_DELIVERY_SECRET_ACCESS_KEY: 'prod-delivery-secret',
  S3_TEST_API_ACCESS_KEY_ID: 'test-api-id',
  S3_TEST_API_SECRET_ACCESS_KEY: 'test-api-secret',
  S3_TEST_WORKER_ACCESS_KEY_ID: 'test-worker-id',
  S3_TEST_WORKER_SECRET_ACCESS_KEY: 'test-worker-secret',
  S3_TEST_DELIVERY_ACCESS_KEY_ID: 'test-delivery-id',
  S3_TEST_DELIVERY_SECRET_ACCESS_KEY: 'test-delivery-secret',
  ...overrides,
});

describe('readTestStorageTarget', () => {
  it('should accept a complete test environment', () => {
    const target = readTestStorageTarget(testEnv());

    expect(target.bucket).toBe('streamtube-videos-test');
    expect(target.identities.worker.accessKeyId).toBe('test-worker-id');
  });

  it('should refuse outside the explicit test context', () => {
    expect(() =>
      readTestStorageTarget(testEnv({ NODE_ENV: 'development' })),
    ).toThrow(TestStorageGuardError);
  });

  it('should refuse when maintenance credentials reach the process under test', () => {
    expect(() =>
      readTestStorageTarget(
        testEnv({ S3_TEST_MAINTENANCE_ACCESS_KEY_ID: 'maint-id' }),
      ),
    ).toThrow(/S3_TEST_MAINTENANCE_ACCESS_KEY_ID/);
  });

  it('should refuse a test bucket equal to the operational bucket', () => {
    expect(() =>
      readTestStorageTarget(testEnv({ S3_BUCKET: 'streamtube-videos-test' })),
    ).toThrow(TestStorageGuardError);
  });

  it.each([
    'S3_TEST_API_ACCESS_KEY_ID',
    'S3_TEST_WORKER_SECRET_ACCESS_KEY',
    'S3_TEST_DELIVERY_ACCESS_KEY_ID',
  ])('should refuse when %s is missing, without falling back', (key) => {
    const env = testEnv();
    delete env[key];

    expect(() => readTestStorageTarget(env)).toThrow(key);
  });

  it('should refuse test identities that are not distinct', () => {
    expect(() =>
      readTestStorageTarget(
        testEnv({ S3_TEST_WORKER_ACCESS_KEY_ID: 'test-api-id' }),
      ),
    ).toThrow(TestStorageGuardError);
  });

  it('should refuse a test identity equal to an operational one', () => {
    expect(() =>
      readTestStorageTarget(
        testEnv({ S3_TEST_DELIVERY_ACCESS_KEY_ID: 'prod-delivery-id' }),
      ),
    ).toThrow(TestStorageGuardError);
  });
});

describe('applyTestStorageEnv', () => {
  it('should map the test bucket and the test API/delivery identities', () => {
    const env = testEnv();

    applyTestStorageEnv(env);

    expect(env).toMatchObject({
      S3_BUCKET: 'streamtube-videos-test',
      S3_ACCESS_KEY_ID: 'test-api-id',
      S3_SECRET_ACCESS_KEY: 'test-api-secret',
      S3_DELIVERY_ACCESS_KEY_ID: 'test-delivery-id',
      S3_DELIVERY_SECRET_ACCESS_KEY: 'test-delivery-secret',
    });
  });

  it('should be idempotent and keep comparing with the operational values', () => {
    const env = testEnv();

    applyTestStorageEnv(env);
    expect(() => applyTestStorageEnv(env)).not.toThrow();
    expect(env.S3_ACCESS_KEY_ID).toBe('test-api-id');
  });

  it('should leave env untouched when the target is invalid', () => {
    const env = testEnv({ S3_TEST_BUCKET: 'streamtube-videos' });

    expect(() => applyTestStorageEnv(env)).toThrow(TestStorageGuardError);
    expect(env.S3_ACCESS_KEY_ID).toBe('prod-api-id');
  });
});

describe('testWorkerProcessEnv', () => {
  it('should give a spawned worker only the test worker identity', () => {
    const env = testEnv();
    applyTestStorageEnv(env);

    const child = testWorkerProcessEnv(env);

    expect(child.S3_ACCESS_KEY_ID).toBe('test-worker-id');
    expect(child.S3_SECRET_ACCESS_KEY).toBe('test-worker-secret');
    expect(child).not.toHaveProperty('S3_DELIVERY_ACCESS_KEY_ID');
    expect(child).not.toHaveProperty('S3_DELIVERY_SECRET_ACCESS_KEY');
  });
});
