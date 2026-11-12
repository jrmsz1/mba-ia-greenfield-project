/** Queue names (phase-03-videos plan, §Events/Messages). */
export const QUEUES = {
  VIDEO_PROCESS: 'video.process',
  VIDEO_RECONCILE: 'video.reconcile',
} as const;

/**
 * `exclusive` + singletonKey = at most one queued-or-active job per key
 * (SI-03.1 spike finding: `standard` does not dedupe by singletonKey).
 */
export const QUEUE_POLICY = 'exclusive' as const;

/** Retry policy for transient processing errors (phase-03-videos/TD-05). */
export const VIDEO_PROCESS_RETRY = {
  LIMIT: 3,
  DELAY_SECONDS: 30,
  BACKOFF: true,
} as const;

/** Reconciler cadence (phase-03-videos/TD-14, SI-03.15). */
export const RECONCILE_CRON = '*/5 * * * *';

/** Injection token for the PgBoss instance. */
export const PGBOSS = Symbol('PGBOSS');

/** Injection token for the QueueModule role options. */
export const QUEUE_MODULE_OPTIONS = Symbol('QUEUE_MODULE_OPTIONS');

export const QUEUE_SCHEMA_PATTERN = /^[a-z][a-z0-9_]*$/;
