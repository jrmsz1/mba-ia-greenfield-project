import type { EntityManager } from 'typeorm';

/** Counter column pairs that may be reserved (whitelist: identifiers are interpolated). */
export const WINDOWED_COUNTERS = {
  control: {
    count: 'control_calls_issued',
    windowStart: 'control_window_started_at',
  },
  delivery: {
    count: 'delivery_urls_issued',
    windowStart: 'delivery_window_started_at',
  },
} as const;

export type WindowedCounter = keyof typeof WINDOWED_COUNTERS;

/**
 * Atomically reserves one call in a one-hour window for a video
 * (phase-03-videos/TD-13 abuse limits, PostgreSQL only — no Redis). A single
 * UPDATE either opens a fresh window, increments below the limit, or affects
 * no row; concurrent callers can never exceed `limit`.
 *
 * @returns true when the call was reserved, false when the limit is reached.
 */
export async function reserveWindowedCall(
  manager: EntityManager,
  videoId: string,
  counter: WindowedCounter,
  limit: number,
): Promise<boolean> {
  const { count, windowStart } = WINDOWED_COUNTERS[counter];
  const expired = `("${windowStart}" IS NULL OR "${windowStart}" < now() - interval '1 hour')`;
  const rows: unknown[] = await manager.query(
    `UPDATE "videos" SET
       "${count}" = CASE WHEN ${expired} THEN 1 ELSE "${count}" + 1 END,
       "${windowStart}" = CASE WHEN ${expired} THEN now() ELSE "${windowStart}" END
     WHERE id = $1 AND (${expired} OR "${count}" < $2)
     RETURNING id`,
    [videoId, limit],
  );
  return firstRows(rows).length > 0;
}

/**
 * TypeORM returns `[rows, affected]` for an UPDATE … RETURNING on PostgreSQL.
 */
export function firstRows(result: unknown[]): unknown[] {
  return Array.isArray(result[0]) ? (result[0] as unknown[]) : result;
}
