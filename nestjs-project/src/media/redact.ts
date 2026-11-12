/**
 * Log hygiene for presigned URLs (phase-03-videos/TD-07, TD-13): FFmpeg echoes
 * the whole input URL in its messages. The entire query string — credential,
 * signature, date, expiry and token — is removed from anything logged or
 * stored, and any stray `X-Amz-*` parameter is masked too.
 */
const URL_QUERY = /(https?:\/\/[^\s'"?<>]+)\?[^\s'"<>]*/gi;
const AMZ_PARAM = /X-Amz-[A-Za-z-]+=[^&\s'"<>]*/gi;

export const REDACTED = '[redacted]';

export function redactPresignedUrl(text: string): string {
  return text.replace(URL_QUERY, `$1?${REDACTED}`).replace(AMZ_PARAM, REDACTED);
}
