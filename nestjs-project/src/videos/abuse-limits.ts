/**
 * PostgreSQL-backed abuse limits (phase-03-videos/TD-13; plan §Error
 * Catalog). Code constants on purpose: TD-16's canonical key list is closed.
 */
export const ABUSE_LIMITS = {
  /** Videos a channel owner may create per rolling hour. */
  UPLOAD_STARTS_PER_HOUR: 20,
  /** Part URLs per upload = factor × expected_part_count. */
  PART_URL_FACTOR: 10,
  /** Playback + download URLs per video per one-hour window. */
  DELIVERY_URLS_PER_HOUR: 60,
  /** GET …/upload + POST …/complete calls per video per one-hour window. */
  CONTROL_CALLS_PER_HOUR: 120,
} as const;

/** Reservations without an upload id are investigated after this age (SI-03.15). */
export const RESERVATION_STALE_MINUTES = 15;

/** Statuses that hold quota (plan §Data Model → Quota accounting). */
export const QUOTA_HOLDING_STATUSES = ['uploading', 'completing'] as const;
