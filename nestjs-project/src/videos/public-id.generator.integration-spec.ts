import { DataSource, QueryFailedError } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  buildVideoValues,
  createTestOwner,
  type TestOwner,
} from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import {
  insertWithUniquePublicId,
  PublicIdExhaustedError,
} from './public-id.generator';

const ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('insertWithUniquePublicId (integration)', () => {
  let dataSource: DataSource;
  let owner: TestOwner;

  beforeAll(async () => {
    dataSource = createTestDataSource(ENTITIES, { synchronize: false });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    owner = await createTestOwner(dataSource);
  });

  it('should retry with a new public_id on collision and keep the transaction usable', async () => {
    await dataSource.getRepository(Video).insert({
      public_id: 'COLLIDE0001',
      ...buildVideoValues(owner.channel.id),
    });
    const ids = ['COLLIDE0001', 'FRESHID0002'];

    const video = await dataSource.transaction(async (manager) => {
      const inserted = await insertWithUniquePublicId(
        manager,
        buildVideoValues(owner.channel.id),
        () => ids.shift() as string,
      );
      // The transaction was not aborted by the collision.
      await manager.query('SELECT 1');
      return inserted;
    });

    expect(video.public_id).toBe('FRESHID0002');
    expect(await dataSource.getRepository(Video).count()).toBe(2);
  });

  it('should give up after 3 collisions without writing a row', async () => {
    await dataSource.getRepository(Video).insert({
      public_id: 'ALWAYSSAME1',
      ...buildVideoValues(owner.channel.id),
    });

    await expect(
      dataSource.transaction(
        async (manager) =>
          await insertWithUniquePublicId(
            manager,
            buildVideoValues(owner.channel.id),
            () => 'ALWAYSSAME1',
          ),
      ),
    ).rejects.toBeInstanceOf(PublicIdExhaustedError);
    expect(await dataSource.getRepository(Video).count()).toBe(1);
  });

  it('should still raise a violation of another unique index', async () => {
    await dataSource.getRepository(Video).insert({
      public_id: 'FIRSTVIDEO1',
      ...buildVideoValues(owner.channel.id, { idempotency_key: 'dup-key' }),
    });

    await expect(
      dataSource.transaction(
        async (manager) =>
          await insertWithUniquePublicId(
            manager,
            buildVideoValues(owner.channel.id, { idempotency_key: 'dup-key' }),
          ),
      ),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });
});
