import type { DynamicModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  DataSource,
  type DataSourceOptions,
  type MigrationInterface,
} from 'typeorm';
import {
  assertConnectedToTestDatabase,
  readTestDatabaseConfig,
  TestDatabaseGuardError,
} from './test-database';

type TestEntities = NonNullable<DataSourceOptions['entities']>;

interface TestDataSourceOptions {
  synchronize?: boolean;
  migrations?: (new () => MigrationInterface)[];
}

/**
 * DataSource that verifies the effective connection (database name + server
 * identity) BEFORE running any of the schema-altering steps TypeORM would
 * otherwise execute inside `initialize()` (dropSchema, migrationsRun,
 * synchronize).
 */
export class TestDataSource extends DataSource {
  private readonly deferredDropSchema: boolean;
  private readonly deferredMigrationsRun: boolean;
  private readonly deferredSynchronize: boolean;

  constructor(options: DataSourceOptions) {
    super({
      ...options,
      dropSchema: false,
      migrationsRun: false,
      synchronize: false,
    });
    this.deferredDropSchema = options.dropSchema ?? false;
    this.deferredMigrationsRun = options.migrationsRun ?? false;
    this.deferredSynchronize = options.synchronize ?? false;
  }

  override async initialize(): Promise<this> {
    await super.initialize();
    try {
      await assertConnectedToTestDatabase(this);
      if (this.deferredDropSchema) await this.dropDatabase();
      if (this.deferredMigrationsRun) {
        await this.runMigrations({
          transaction: this.options.migrationsTransactionMode,
        });
      }
      if (this.deferredSynchronize) await this.synchronize();
    } catch (error) {
      if (this.isInitialized) await this.destroy();
      throw error;
    }
    return this;
  }
}

function buildTestDataSourceOptions(
  entities: TestEntities,
  options: TestDataSourceOptions,
): DataSourceOptions {
  const { synchronize = true, migrations } = options;
  const config = readTestDatabaseConfig();
  return {
    type: 'postgres',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    entities,
    synchronize,
    ...(migrations !== undefined && { migrations, migrationsRun: false }),
  };
}

export function createTestDataSource(
  entities: TestEntities,
  options: TestDataSourceOptions = {},
): TestDataSource {
  return new TestDataSource(buildTestDataSourceOptions(entities, options));
}

/**
 * `TypeOrmModule` root for Nest testing modules. Uses `TestDataSource` so the
 * target is verified before synchronize; retries are disabled so a guard
 * failure aborts immediately instead of being retried.
 */
export function createTestTypeOrmModule(
  entities: TestEntities,
  options: TestDataSourceOptions = {},
): DynamicModule {
  return TypeOrmModule.forRootAsync({
    useFactory: () => ({
      ...buildTestDataSourceOptions(entities, options),
      retryAttempts: 0,
    }),
    dataSourceFactory: (resolved?: DataSourceOptions) => {
      if (!resolved) {
        throw new TestDatabaseGuardError(
          'TypeOrmModule resolved no DataSource options.',
        );
      }
      return Promise.resolve(new TestDataSource(resolved));
    },
  });
}

/**
 * Empties the test schema: drops every table (including `migrations`) and
 * ENUM type, keeping extensions (`uuid-ossp`). TypeORM runs it on a single
 * connection inside one transaction, so the DROPs cannot deadlock each other
 * the way concurrent `DROP TABLE ... CASCADE` on pooled connections do.
 */
export async function resetTestSchema(dataSource: DataSource): Promise<void> {
  await assertConnectedToTestDatabase(dataSource);
  await dataSource.dropDatabase();
}

export async function cleanAllTables(dataSource: DataSource): Promise<void> {
  await assertConnectedToTestDatabase(dataSource);
  await dataSource.query('DELETE FROM "refresh_tokens"');
  await dataSource.query('DELETE FROM "verification_tokens"');
  await dataSource.query('DELETE FROM "channels"');
  await dataSource.query('DELETE FROM "users"');
}
