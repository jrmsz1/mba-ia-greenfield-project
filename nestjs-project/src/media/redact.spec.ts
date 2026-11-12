import { classifyToolFailure, MediaToolError } from './media-errors';
import { REDACTED, redactPresignedUrl } from './redact';

const SIGNED =
  'http://minio:9000/streamtube-videos/videos/abc/original?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=KEY%2F20261112%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261112T000000Z&X-Amz-Expires=900&X-Amz-Signature=deadbeef&X-Amz-SignedHeaders=host';

describe('redactPresignedUrl', () => {
  it('removes the whole query string of a presigned URL, keeping the path', () => {
    const out = redactPresignedUrl(
      `[http @ 0x1] HTTP error 403 Forbidden\n${SIGNED}: Server returned 403 Forbidden`,
    );

    expect(out).toContain(
      `http://minio:9000/streamtube-videos/videos/abc/original?${REDACTED}`,
    );
    expect(out).not.toMatch(/X-Amz-/i);
    expect(out).not.toContain('deadbeef');
  });

  it('masks stray X-Amz-* parameters outside a full URL', () => {
    const out = redactPresignedUrl(
      'retry with X-Amz-Signature=abc123&X-Amz-Security-Token=tok',
    );

    expect(out).not.toMatch(/abc123|tok\b/);
    expect(out).not.toMatch(/X-Amz-Signature=/i);
  });

  it('leaves text without URLs untouched', () => {
    expect(redactPresignedUrl('moov atom not found')).toBe(
      'moov atom not found',
    );
  });

  it('is applied to every MediaToolError message', () => {
    const error = new MediaToolError('transient', 'ffprobe', `${SIGNED}: boom`);

    expect(error.message).not.toMatch(/X-Amz-/i);
  });
});

describe('classifyToolFailure', () => {
  it.each([
    'Server returned 403 Forbidden (access denied)',
    'Server returned 5XX Server Error reply'.replace('5XX', '503'),
    'Connection refused',
    'Connection timed out',
    'Failed to resolve hostname minio',
  ])('classifies "%s" as transient', (stderr) => {
    expect(classifyToolFailure(stderr)).toBe('transient');
  });

  it.each([
    'moov atom not found\nInvalid data found when processing input',
    'Invalid data found when processing input',
  ])('classifies "%s" as permanent', (stderr) => {
    expect(classifyToolFailure(stderr)).toBe('permanent');
  });
});
