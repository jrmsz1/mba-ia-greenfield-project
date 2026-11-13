import { DataSource } from 'typeorm';
import { prepareTestDatabase } from './prepare-test-database';
import { TestDatabaseGuardError } from './test-database';

// prepareTestDatabase() backs both the Jest globalSetup and the standalone
// `npm run test:db:prepare`. It must reject an unsafe configuration before
// opening any connection (and therefore before any destructive operation).
describe('prepareTestDatabase', () => {
  const originalEnv = process.env;
  let initialize: jest.SpyInstance;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DB_HOST: 'db',
      DB_PORT: '5432',
      DB_USERNAME: 'streamtube',
      DB_PASSWORD: 'streamtube',
      DB_TEST_NAME: 'streamtube_test',
      DB_TEST_SERVER_ID: '1234567890123456789',
    };
    initialize = jest
      .spyOn(DataSource.prototype, 'initialize')
      .mockRejectedValue(new Error('unexpected connection attempt'));
  });

  afterEach(() => {
    initialize.mockRestore();
    process.env = originalEnv;
  });

  it('should reject DB_NAME equal to DB_TEST_NAME before connecting', async () => {
    process.env.DB_NAME = 'streamtube_test';

    await expect(prepareTestDatabase()).rejects.toThrow(TestDatabaseGuardError);
    expect(initialize).not.toHaveBeenCalled();
  });

  it('should reject DB_NAME equal to DB_TEST_NAME even with a forged original name', async () => {
    process.env.DB_NAME = 'streamtube_test';
    process.env.DB_NAME_BEFORE_TEST_OVERRIDE = 'streamtube';

    await expect(prepareTestDatabase()).rejects.toThrow(TestDatabaseGuardError);
    expect(initialize).not.toHaveBeenCalled();
  });

  it('should proceed to connect when DB_NAME is the development database', async () => {
    process.env.DB_NAME = 'streamtube';

    await expect(prepareTestDatabase()).rejects.toThrow(
      'unexpected connection attempt',
    );
    expect(initialize).toHaveBeenCalledTimes(1);
  });
});
