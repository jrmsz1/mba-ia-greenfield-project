import { randomBytes } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { Video } from './entities/video.entity';
import { PUBLIC_ID } from './video.constants';

/**
 * 11 base62 characters from `crypto` randomness with rejection sampling: bytes
 * >= 248 (the largest multiple of 62 below 256) are discarded, so every
 * character is uniform — no modulo bias (phase-03-videos/TD-10).
 */
export function generatePublicId(
  random: (size: number) => Buffer = randomBytes,
): string {
  const limit = 256 - (256 % PUBLIC_ID.ALPHABET.length); // 248
  let id = '';
  while (id.length < PUBLIC_ID.LENGTH) {
    for (const byte of random(PUBLIC_ID.LENGTH * 2)) {
      if (byte >= limit) continue;
      id += PUBLIC_ID.ALPHABET[byte % PUBLIC_ID.ALPHABET.length];
      if (id.length === PUBLIC_ID.LENGTH) break;
    }
  }
  return id;
}

export class PublicIdExhaustedError extends Error {
  constructor(attempts: number) {
    super(`Could not generate a unique public_id after ${attempts} attempts.`);
    this.name = 'PublicIdExhaustedError';
  }
}

/**
 * Inserts a video, retrying ONLY on a `public_id` collision. The conflict
 * target is restricted to `public_id`, so the statement does not fail and the
 * surrounding transaction is never aborted (avoids the CHANNEL-NICKNAME-RACE
 * trap); any other constraint violation — e.g. the (channel_id,
 * idempotency_key) unique index — still raises.
 */
export async function insertWithUniquePublicId(
  manager: EntityManager,
  values: Omit<Partial<Video>, 'public_id'>,
  generate: () => string = generatePublicId,
): Promise<Video> {
  for (let attempt = 1; attempt <= PUBLIC_ID.MAX_INSERT_ATTEMPTS; attempt++) {
    const result = await manager
      .createQueryBuilder()
      .insert()
      .into(Video)
      .values({ ...values, public_id: generate() })
      // `onConflict` is the only InsertQueryBuilder form that names the
      // conflict target; `orIgnore()` would ignore every unique violation.
      .onConflict('("public_id") DO NOTHING')
      .returning('id')
      .execute();
    const rows = result.raw as { id: string }[];
    if (rows.length > 0) {
      return await manager.findOneByOrFail(Video, { id: rows[0].id });
    }
  }
  throw new PublicIdExhaustedError(PUBLIC_ID.MAX_INSERT_ATTEMPTS);
}
