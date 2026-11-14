/** Longest accepted title, in characters (videos.title varchar). */
export const VIDEO_TITLE_MAX_LENGTH = 100;

/**
 * Title stored at upload start. The client's title is kept (trimmed); without
 * one, the draft is named after the sanitized file name minus its extension,
 * so every video has a title from the first request. Migration
 * `AddVideoTitle1794622489462` fills existing rows with the same rule.
 */
export function resolveTitle(
  title: string | undefined,
  sanitizedFilename: string,
): string {
  const given = title?.trim();
  if (given) return truncate(given);
  // Spaces only, like PostgreSQL btrim() in the backfill: same result per row.
  const withoutExtension = sanitizedFilename
    .replace(/\.[^.]*$/, '')
    .replace(/^ +| +$/g, '');
  return truncate(
    withoutExtension === '' ? sanitizedFilename : withoutExtension,
  );
}

/** Cuts by code point, so a multi-byte character is never split. */
function truncate(value: string): string {
  return [...value].slice(0, VIDEO_TITLE_MAX_LENGTH).join('');
}
