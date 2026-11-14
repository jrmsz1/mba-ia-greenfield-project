import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, type Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import {
  buildVideoValues,
  createTestOwner,
  type TestOwner,
} from '../../test/video-fixtures';
import { User } from '../../users/entities/user.entity';
import { Video } from './video.entity';

const ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let owner: TestOwner;

  beforeAll(async () => {
    dataSource = createTestDataSource(ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videos = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    owner = await createTestOwner(dataSource);
  });

  const insert = async (overrides: Partial<Video> = {}) =>
    await videos.insert({
      public_id: randomUUID().replace(/-/g, '').slice(0, 11),
      ...buildVideoValues(owner.channel.id, overrides),
    });

  it('should default publication to draft and the counters to zero', async () => {
    const { identifiers } = await insert();

    const video = await videos.findOneByOrFail({
      id: identifiers[0].id as string,
    });

    expect(video.publication).toBe('draft');
    expect(video.part_urls_issued).toBe(0);
    expect(video.delivery_urls_issued).toBe(0);
    expect(video.control_calls_issued).toBe(0);
    expect(video.processing_attempts).toBe(0);
    expect(video.declared_size_bytes).toBe(10 * 1024 * 1024);
  });

  it('should keep upload_binding_token out of default queries', async () => {
    const { identifiers } = await insert({
      upload_binding_token: 'secret-binding',
    });
    const id = identifiers[0].id as string;

    const plain = await videos.findOneByOrFail({ id });
    const withToken = await videos
      .createQueryBuilder('v')
      .addSelect('v.upload_binding_token')
      .where('v.id = :id', { id })
      .getOneOrFail();

    expect(plain.upload_binding_token).toBeUndefined();
    expect(withToken.upload_binding_token).toBe('secret-binding');
  });

  it('should reject a video without a title', async () => {
    await expect(
      insert({ title: null } as unknown as Partial<Video>),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should reject a title longer than 100 characters', async () => {
    await expect(insert({ title: 'a'.repeat(101) })).rejects.toBeInstanceOf(
      QueryFailedError,
    );
  });

  it('should reject a duplicate public_id', async () => {
    await insert({ public_id: 'AAAAAAAAAAA' } as Partial<Video>);

    await expect(
      insert({ public_id: 'AAAAAAAAAAA' } as Partial<Video>),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should reject a duplicate (channel_id, idempotency_key)', async () => {
    await insert({ idempotency_key: 'same-key' });

    await expect(
      insert({ idempotency_key: 'same-key' }),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should accept the same idempotency key on another channel', async () => {
    const other = await createTestOwner(dataSource);
    await insert({ idempotency_key: 'shared-key' });

    await expect(
      videos.insert({
        public_id: 'BBBBBBBBBBB',
        ...buildVideoValues(other.channel.id, {
          idempotency_key: 'shared-key',
        }),
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['declared_size_bytes = 0', { declared_size_bytes: 0 }],
    ['expected_part_count = 10001', { expected_part_count: 10_001 }],
    ['expected_part_count = 0', { expected_part_count: 0 }],
  ])('should reject %s through a check constraint', async (_, overrides) => {
    await expect(insert(overrides)).rejects.toThrow(/CHK_videos_/);
  });

  it('should refuse to delete a channel that still has videos', async () => {
    await insert();

    await expect(
      dataSource.query('DELETE FROM "channels" WHERE id = $1', [
        owner.channel.id,
      ]),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });
});
