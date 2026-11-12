/** Phase 03 only writes `draft`; Phase 04 adds the published value (AMB-1). */
export const VIDEO_PUBLICATIONS = ['draft'] as const;
export type VideoPublication = (typeof VIDEO_PUBLICATIONS)[number];

/** Lifecycle of phase-03-videos/TD-09. */
export const VIDEO_PROCESSING_STATUSES = [
  'uploading',
  'completing',
  'uploaded',
  'processing',
  'ready',
  'failed',
  'expired',
  'cancelled',
] as const;
export type VideoProcessingStatus = (typeof VIDEO_PROCESSING_STATUSES)[number];

/** `failure_reason` codes (plan §Error Catalog — stored, never thrown). */
export const FAILURE_REASONS = {
  UPLOAD_LOST: 'UPLOAD_LOST',
  UPLOAD_INVALID: 'UPLOAD_INVALID',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  DURATION_LIMIT_EXCEEDED: 'DURATION_LIMIT_EXCEEDED',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
} as const;

/** Public identifier: 11 base62 characters (phase-03-videos/TD-10). */
export const PUBLIC_ID = {
  LENGTH: 11,
  ALPHABET: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  MAX_INSERT_ATTEMPTS: 3,
} as const;

export const PUBLIC_ID_PATTERN = /^[0-9A-Za-z]{11}$/;

/** Probe summary stored in videos.media_metadata (plan §Data Model; TD-07). */
export interface MediaMetadata {
  format_name: string;
  major_brand: string | null;
  video: {
    codec_name: string;
    width: number;
    height: number;
    pix_fmt: string;
  };
  audio: { codec_name: string } | null;
  bit_rate: number | null;
  size: number | null;
}
