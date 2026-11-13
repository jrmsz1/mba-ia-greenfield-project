import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { thumbnailPositionSeconds, withJobTempDir } from './thumbnail-policy';

describe('thumbnailPositionSeconds', () => {
  it.each([
    [0.5, 0],
    [1.99, 0],
    [2, 1],
    [5, 1],
    [30, 3],
    [100, 10],
    [14_400, 10],
  ])('for a %ss clip picks %ss', (duration, expected) => {
    expect(thumbnailPositionSeconds(duration)).toBe(expected);
  });
});

describe('withJobTempDir', () => {
  it('removes the directory after success', async () => {
    let seen = '';
    await withJobTempDir(async (dir) => {
      seen = dir;
      await writeFile(join(dir, 'thumb.jpg'), 'x');
    });

    expect(existsSync(seen)).toBe(false);
  });

  it('removes the directory after a failure and rethrows', async () => {
    let seen = '';
    const failing = withJobTempDir(async (dir) => {
      seen = dir;
      await writeFile(join(dir, 'partial.jpg'), 'x');
      throw new Error('decode failed');
    });

    await expect(failing).rejects.toThrow('decode failed');
    expect(existsSync(seen)).toBe(false);
  });
});
