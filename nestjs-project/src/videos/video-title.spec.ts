import { VIDEO_TITLE_MAX_LENGTH, resolveTitle } from './video-title';

describe('resolveTitle', () => {
  it('keeps the client title, trimmed', () => {
    expect(resolveTitle('  My trip  ', 'clip.mp4')).toBe('My trip');
  });

  it('derives the title from the file name without its extension', () => {
    expect(resolveTitle(undefined, 'Summer holidays.mp4')).toBe(
      'Summer holidays',
    );
  });

  it('removes only the last extension', () => {
    expect(resolveTitle(undefined, 'archive.final.mp4')).toBe('archive.final');
  });

  it('falls back to the derived title when the given one is blank', () => {
    expect(resolveTitle('   ', 'clip.mp4')).toBe('clip');
  });

  it('keeps the whole file name when nothing is left without the extension', () => {
    expect(resolveTitle(undefined, '.mp4')).toBe('.mp4');
  });

  it(`truncates to ${VIDEO_TITLE_MAX_LENGTH} characters without splitting a character`, () => {
    const long = '🎬'.repeat(VIDEO_TITLE_MAX_LENGTH + 5);

    const title = resolveTitle(undefined, `${long}.mp4`);

    expect([...title]).toHaveLength(VIDEO_TITLE_MAX_LENGTH);
    expect(title).toBe('🎬'.repeat(VIDEO_TITLE_MAX_LENGTH));
  });
});
