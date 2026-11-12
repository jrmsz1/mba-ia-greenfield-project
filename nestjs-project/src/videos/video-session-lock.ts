import { Logger } from '@nestjs/common';
import { Client, type ClientConfig } from 'pg';
import type { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

export type LockedResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

const logger = new Logger('VideoSessionLock');

function lockConnectionOptions(dataSource: DataSource): ClientConfig {
  const options = dataSource.options as PostgresConnectionOptions;
  return {
    host: options.host,
    port: options.port,
    user: options.username,
    password:
      typeof options.password === 'string' ? options.password : undefined,
    database: options.database,
  };
}

/**
 * Per-video, NON-blocking session advisory lock (phase-03-videos plan SI-03.7,
 * reused by the reconciler of SI-03.15): `pg_try_advisory_lock` on a
 * DEDICATED connection that is never taken from or returned to the pool and
 * is always closed in `finally` — closing it releases the lock even when the
 * explicit unlock is not confirmed. A busy lock returns `{ acquired: false }`
 * immediately; the caller decides what that means.
 */
export async function withVideoSessionLock<T>(
  dataSource: DataSource,
  videoId: string,
  work: () => Promise<T>,
): Promise<LockedResult<T>> {
  const client = new Client(lockConnectionOptions(dataSource));
  await client.connect();
  let locked = false;
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [videoId],
    );
    if (!rows[0].acquired) return { acquired: false };
    locked = true;
    return { acquired: true, value: await work() };
  } finally {
    if (locked && !(await sessionLockOps.unlock(client, videoId))) {
      logger.warn(
        `advisory unlock not confirmed for video ${videoId}; closing the lock connection releases it`,
      );
    }
    await client.end();
  }
}

/**
 * Lock operations behind an object so a test can simulate an unconfirmed
 * unlock (the connection is then discarded and PostgreSQL releases the lock).
 */
export const sessionLockOps = { unlock };

async function unlock(client: Client, videoId: string): Promise<boolean> {
  try {
    const { rows } = await client.query<{ released: boolean }>(
      'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released',
      [videoId],
    );
    return rows[0].released === true;
  } catch (error) {
    logger.warn(
      `advisory unlock failed for video ${videoId}: ${String(error)}`,
    );
    return false;
  }
}
