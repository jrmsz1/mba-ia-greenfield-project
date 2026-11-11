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
});

describe('applyTestDatabaseEnv', () => {
  it('should point DB_NAME at the test database', () => {
    const env = { ...VALID_ENV };

    applyTestDatabaseEnv(env);

    expect(env.DB_NAME).toBe('streamtube_test');
  });

  it('should be idempotent once applied', () => {
    const env = { ...VALID_ENV, DB_NAME: 'streamtube_test' };

    applyTestDatabaseEnv(env);

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
