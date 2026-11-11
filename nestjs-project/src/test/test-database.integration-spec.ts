import { DataSource } from 'typeorm';
import { TestDataSource } from './create-test-data-source';
import {
  assertConnectedToTestDatabase,
  readTestDatabaseConfig,
  TestDatabaseGuardError,
} from './test-database';

// Negative cases connect to the `postgres` maintenance database with NO
// entities, so even a broken guard would have nothing to synchronize.
const NON_TEST_DATABASE = 'postgres';

describe('Test database guard (integration)', () => {
  const config = readTestDatabaseConfig();
  const connection = {
    type: 'postgres' as const,
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
  };

  it('should accept the configured test database on the authorized server', async () => {
    const dataSource = new TestDataSource({
      ...connection,
      database: config.database,
    });

    await dataSource.initialize();
    try {
      await expect(
        assertConnectedToTestDatabase(dataSource),
      ).resolves.toBeUndefined();
    } finally {
      await dataSource.destroy();
    }
  });

  it('should abort initialize before synchronize when connected to a non-test database', async () => {
    const dataSource = new TestDataSource({
      ...connection,
      database: NON_TEST_DATABASE,
      entities: [],
      synchronize: true,
    });
    const synchronizeSpy = jest.spyOn(dataSource, 'synchronize');

    await expect(dataSource.initialize()).rejects.toThrow(
      TestDatabaseGuardError,
    );
    expect(synchronizeSpy).not.toHaveBeenCalled();
    expect(dataSource.isInitialized).toBe(false);
  });

  it('should reject a connection whose server identity differs from DB_TEST_SERVER_ID', async () => {
    const dataSource = new DataSource({
      ...connection,
      database: config.database,
    });
    await dataSource.initialize();
    try {
      await expect(
        assertConnectedToTestDatabase(dataSource, {
          ...config,
          serverSystemId: '1',
        }),
      ).rejects.toThrow(TestDatabaseGuardError);
    } finally {
      await dataSource.destroy();
    }
  });
});
