import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOB_TEMP_DIR_PREFIX, THUMBNAIL_POLICY } from './media.constants';

/**
 * Thumbnail position (phase-03-videos/TD-07): 10% of the duration bounded to
 * [1 s, 10 s]; the first frame for clips shorter than 2 s.
 */
export function thumbnailPositionSeconds(durationSeconds: number): number {
  if (durationSeconds < THUMBNAIL_POLICY.SHORT_CLIP_SECONDS) return 0;
  const position = durationSeconds * THUMBNAIL_POLICY.FRACTION;
  return Math.min(
    THUMBNAIL_POLICY.MAX_SECONDS,
    Math.max(THUMBNAIL_POLICY.MIN_SECONDS, position),
  );
}

/**
 * Runs `work` with a per-job temporary directory that is removed in
 * `finally` — on success and on failure (phase-03-videos/TD-07, TD-08).
 */
export async function withJobTempDir<T>(
  work: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), JOB_TEMP_DIR_PREFIX));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
