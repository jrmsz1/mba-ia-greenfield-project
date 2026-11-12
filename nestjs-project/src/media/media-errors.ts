import { redactPresignedUrl } from './redact';

/**
 * Failure of a media tool, classified by CAUSE (phase-03-videos/TD-07):
 * `permanent` — the input is not valid media (never retried);
 * `transient` — storage/network trouble or a timeout (retried by the queue).
 * The exit code alone cannot tell them apart, so the stderr pattern decides.
 * Messages are always redacted: no presigned URL, no `X-Amz-*` parameter.
 */
export type MediaFailureKind = 'permanent' | 'transient';

export class MediaToolError extends Error {
  constructor(
    readonly kind: MediaFailureKind,
    readonly tool: string,
    detail: string,
  ) {
    super(redactPresignedUrl(`${tool}: ${detail}`));
    this.name = 'MediaToolError';
  }
}

/** Network / storage signatures printed by FFmpeg's protocol layer. */
const TRANSIENT_STDERR = [
  /Server returned [45]\d\d/i,
  /HTTP error [45]\d\d/i,
  /Connection refused/i,
  /Connection reset/i,
  /Connection timed out/i,
  /Operation timed out/i,
  /Network is unreachable/i,
  /Failed to resolve hostname/i,
  /No route to host/i,
  /I\/O error/i,
];

export function classifyToolFailure(stderr: string): MediaFailureKind {
  return TRANSIENT_STDERR.some((pattern) => pattern.test(stderr))
    ? 'transient'
    : 'permanent';
}
