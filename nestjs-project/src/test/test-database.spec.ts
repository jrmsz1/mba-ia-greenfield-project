import {
  applyTestDatabaseEnv,
  readTestDatabaseConfig,
  TestDatabaseGuardError,
} from './test-database';

const VALID_ENV: NodeJS.ProcessEnv = {
  DB_HOST: 'db',
  DB_PORT: '5432',
  DB_USERNAME: 'streamtube',
  DB_PASSWORD: 'streamtube',
  DB_NAME: 'streamtube',
  DB_TEST_NAME: 'streamtube_test',
  DB_TEST_SERVER_ID: '1234567890123456789',
};

describe('readTestDatabaseConfig', () => {
  it('should target DB_TEST_NAME, never DB_NAME', () => {
    const config = readTestDatabaseConfig({ ...VALID_ENV });

    expect(config.database).toBe('streamtube_test');
    expect(config.port).toBe(5432);
  });

  it.each(['DB_TEST_NAME', 'DB_TEST_SERVER_ID', 'DB_HOST', 'DB_PORT'])(
    'should refuse to fall back when %s is missing',
    (key) => {
      const env = { ...VALID_ENV, [key]: undefined };

      expect(() => readTestDatabaseConfig(env)).toThrow(TestDatabaseGuardError);
    },
  );

  it.each([
    'streamtube',
    'streamtube_testing',
    'Streamtube_test',
    'x"; --_test',
  ])('should reject non-test database name %p', (name) => {
    const env = { ...VALID_ENV, DB_TEST_NAME: name };

    expect(() => readTestDatabaseConfig(env)).toThrow(TestDatabaseGuardError);
  });

  it('should reject a non-numeric server identifier', () => {
    const env = { ...VALID_ENV, DB_TEST_SERVER_ID: 'db' };

    expect(() => readTestDatabaseConfig(env)).toThrow(TestDatabaseGuardError);
  });

  it('should allow development "streamtube" with test "streamtube_test"', () => {
    expect(() => readTestDatabaseConfig({ ...VALID_ENV })).not.toThrow();
  });

  it('should allow an unset DB_NAME', () => {
    const env = { ...VALID_ENV, DB_NAME: undefined };

    expect(() => readTestDatabaseConfig(env)).not.toThrow();
  });

  it('should reject a development database equal to the test database', () => {
    const env = { ...VALID_ENV, DB_NAME: 'streamtube_test' };

    expect(() => readTestDatabaseConfig(env)).toThrow(
      /DB_NAME and DB_TEST_NAME are both "streamtube_test"/,
    );
  });

  it('should reject a development database that is another test database', () => {
    const env = { ...VALID_ENV, DB_NAME: 'other_test' };

    expect(() => readTestDatabaseConfig(env)).toThrow(/ambiguous/);
  });

  it('should not trust an externally provided original DB_NAME', () => {
    const env = {
      ...VALID_ENV,
      DB_NAME: 'streamtube_test',
      DB_NAME_BEFORE_TEST_OVERRIDE: 'streamtube',
    };

    expect(() => readTestDatabaseConfig(env)).toThrow(
      /DB_NAME and DB_TEST_NAME are both "streamtube_test"/,
    );
  });
});

describe('applyTestDatabaseEnv', () => {
  it('should point DB_NAME at the test database', () => {
    const env = { ...VALID_ENV };

    applyTestDatabaseEnv(env);

    expect(env.DB_NAME).toBe('streamtube_test');
  });

  it('should be idempotent across consecutive calls after a valid initialization', () => {
    const env = { ...VALID_ENV };

    applyTestDatabaseEnv(env);
    applyTestDatabaseEnv(env);

    expect(env.DB_NAME).toBe('streamtube_test');
    expect(() => readTestDatabaseConfig(env)).not.toThrow();
  });

  it('should keep the original DB_NAME private to the rewritten env object', () => {
    const env = { ...VALID_ENV };
    applyTestDatabaseEnv(env);

    // A copy carries the rewritten DB_NAME but not the private record.
    expect(() => readTestDatabaseConfig({ ...env })).toThrow(
      TestDatabaseGuardError,
    );
  });

  it('should reject DB_NAME later changed to an unsafe value', () => {
    const env = { ...VALID_ENV };
    applyTestDatabaseEnv(env);

    env.DB_NAME = 'other_test';

    expect(() => readTestDatabaseConfig(env)).toThrow(/ambiguous/);
    expect(() => applyTestDatabaseEnv(env)).toThrow(TestDatabaseGuardError);
    expect(env.DB_NAME).toBe('other_test');
  });

  it('should reject a development database equal to the test database and leave env untouched', () => {
    const env: NodeJS.ProcessEnv = { ...VALID_ENV, DB_NAME: 'streamtube_test' };

    expect(() => applyTestDatabaseEnv(env)).toThrow(TestDatabaseGuardError);
    expect(env.DB_NAME).toBe('streamtube_test');
    expect(() => applyTestDatabaseEnv(env)).toThrow(TestDatabaseGuardError);
  });

  it('should reject an equal database even with a forged DB_NAME_BEFORE_TEST_OVERRIDE', () => {
    const env: NodeJS.ProcessEnv = {
      ...VALID_ENV,
      DB_NAME: 'streamtube_test',
      DB_NAME_BEFORE_TEST_OVERRIDE: 'streamtube',
    };

    expect(() => applyTestDatabaseEnv(env)).toThrow(
      /DB_NAME and DB_TEST_NAME are both "streamtube_test"/,
    );
    expect(env.DB_NAME).toBe('streamtube_test');
  });

  it('should reject an ambiguous target when DB_NAME is another test database', () => {
    const env = { ...VALID_ENV, DB_NAME: 'other_test' };

    expect(() => applyTestDatabaseEnv(env)).toThrow(TestDatabaseGuardError);
  });

  it('should leave DB_NAME untouched when the test target is invalid', () => {
    const env: NodeJS.ProcessEnv = { ...VALID_ENV, DB_TEST_NAME: 'streamtube' };

    expect(() => applyTestDatabaseEnv(env)).toThrow(TestDatabaseGuardError);
    expect(env.DB_NAME).toBe('streamtube');
  });
});
