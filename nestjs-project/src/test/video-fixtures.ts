import { randomBytes, randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import type { Video } from '../videos/entities/video.entity';

export interface TestOwner {
  user: User;
  channel: Channel;
}

/** Persists a confirmed user with its channel (one channel per user). */
export async function createTestOwner(
  dataSource: DataSource,
): Promise<TestOwner> {
  const suffix = randomBytes(5).toString('hex');
  const user = await dataSource.getRepository(User).save(
    dataSource.getRepository(User).create({
      email: `owner_${suffix}@example.com`,
      password: 'hashed-password',
      is_confirmed: true,
    }),
  );
  const channel = await dataSource.getRepository(Channel).save(
    dataSource.getRepository(Channel).create({
      name: `Channel ${suffix}`,
      nickname: `ch_${suffix}`,
      user_id: user.id,
    }),
  );
  return { user, channel };
}

/** Valid insert values for a draft video in `uploading`. */
export function buildVideoValues(
  channelId: string,
  overrides: Partial<Video> = {},
): Partial<Video> {
  return {
    channel_id: channelId,
    processing_status: 'uploading',
    idempotency_key: `key-${randomUUID()}`,
    original_filename: 'clip.mp4',
    declared_size_bytes: 10 * 1024 * 1024,
    part_size_bytes: 5 * 1024 * 1024,
    expected_part_count: 2,
    upload_binding_token: randomBytes(16).toString('hex'),
    upload_expires_at: new Date(Date.now() + 24 * 3600 * 1000),
    ...overrides,
  };
}
