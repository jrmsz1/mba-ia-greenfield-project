/**
 * Timeout policy for every storage control call (phase-03-videos plan,
 * SI-03.4 action 2): no call waits without a bound.
 */
export const STORAGE_TIMEOUTS = {
  CONNECTION_MS: 3_000,
  REQUEST_MS: 15_000,
} as const;

/** Default SDK attempts for idempotent calls; non-idempotent calls use 1. */
export const STORAGE_RETRY = {
  DEFAULT_MAX_ATTEMPTS: 3,
  SINGLE_ATTEMPT: 1,
} as const;

/** Object metadata key that binds the final object to its upload session (TD-02). */
export const UPLOAD_BINDING_METADATA_KEY = 'upload-binding';

/** Injection token for the three S3 clients. */
export const S3_CLIENTS = Symbol('S3_CLIENTS');

/** Bounds of the abort-until-gone loop (SI-03.4 action 4). */
export const CLEANUP_LIMITS = {
  MAX_ABORT_ATTEMPTS: 5,
  BACKOFF_MS: 200,
} as const;
