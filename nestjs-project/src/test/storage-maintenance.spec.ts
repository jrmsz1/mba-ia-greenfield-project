import {
  readMaintenancePlan,
  StorageMaintenanceGuardError,
} from './storage-maintenance';

/** A complete maintenance environment (fictitious values). */
const maintenanceEnv = (
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => ({
  STREAMTUBE_TEST_MAINTENANCE: '1',
  S3_ENDPOINT: 'http://minio:9000',
  S3_BUCKET: 'streamtube-videos',
  S3_TEST_BUCKET: 'streamtube-videos-test',
  S3_TEST_MAINTENANCE_ACCESS_KEY_ID: 'maint-id',
  S3_TEST_MAINTENANCE_SECRET_ACCESS_KEY: 'maint-secret',
  DB_HOST: 'db',
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_TEST_NAME: 'streamtube_test',
  DB_TEST_SERVER_ID: '1234567890',
  ...overrides,
});

describe('readMaintenancePlan', () => {
  it('should accept the explicit maintenance context on the test bucket', () => {
    const plan = readMaintenancePlan(maintenanceEnv());

    expect(plan.bucket).toBe('streamtube-videos-test');
    expect(plan.accessKeyId).toBe('maint-id');
  });

  it('should refuse without the explicit maintenance marker', () => {
    const env = maintenanceEnv();
    delete env.STREAMTUBE_TEST_MAINTENANCE;

    expect(() => readMaintenancePlan(env)).toThrow(
      StorageMaintenanceGuardError,
    );
  });

  it.each(['streamtube-videos', 'videos-test-data', ''])(
    'should refuse the non-test target "%s"',
    (bucket) => {
      expect(() =>
        readMaintenancePlan(maintenanceEnv({ S3_TEST_BUCKET: bucket })),
      ).toThrow(StorageMaintenanceGuardError);
    },
  );

  it('should refuse a target equal to the operational bucket', () => {
    expect(() =>
      readMaintenancePlan(
        maintenanceEnv({
          S3_BUCKET: 'streamtube-videos-test',
          S3_TEST_BUCKET: 'streamtube-videos-test',
        }),
      ),
    ).toThrow(/ambiguous/);
  });

  it('should refuse when the operational bucket is unknown', () => {
    const env = maintenanceEnv();
    delete env.S3_BUCKET;

    expect(() => readMaintenancePlan(env)).toThrow('S3_BUCKET');
  });

  it.each(['MINIO_ROOT_USER', 'S3_ACCESS_KEY_ID', 'S3_DELIVERY_ACCESS_KEY_ID'])(
    'should refuse to run with %s present (root/operational process)',
    (key) => {
      expect(() => readMaintenancePlan(maintenanceEnv({ [key]: 'x' }))).toThrow(
        key,
      );
    },
  );

  it('should require the maintenance identity', () => {
    const env = maintenanceEnv();
    delete env.S3_TEST_MAINTENANCE_SECRET_ACCESS_KEY;

    expect(() => readMaintenancePlan(env)).toThrow(
      'S3_TEST_MAINTENANCE_SECRET_ACCESS_KEY',
    );
  });
});
