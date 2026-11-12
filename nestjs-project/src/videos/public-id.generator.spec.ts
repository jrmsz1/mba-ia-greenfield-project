import { generatePublicId } from './public-id.generator';
import { PUBLIC_ID, PUBLIC_ID_PATTERN } from './video.constants';

describe('generatePublicId', () => {
  it('should produce 11 base62 characters', () => {
    for (let i = 0; i < 1000; i++) {
      expect(generatePublicId()).toMatch(PUBLIC_ID_PATTERN);
    }
  });

  it('should discard bytes >= 248 instead of folding them (no modulo bias)', () => {
    // 248..255 would map onto '0'..'7' with a plain modulo; they must be skipped.
    const bytes = [248, 255, 250, 0, 61, 62, 247, 252, 1, 2, 3, 4, 5, 6, 7];
    let offset = 0;
    const random = (size: number) => {
      const chunk = Buffer.from(
        Array.from({ length: size }, () => bytes[offset++ % bytes.length]),
      );
      return chunk;
    };

    const id = generatePublicId(random);

    // Skips 248, 255, 250, then 0 -> '0', 61 -> 'z', 62 -> '0', 247 -> 'z' (247 % 62 = 61)...
    expect(id.startsWith('0z0z')).toBe(true);
    expect(id).toHaveLength(PUBLIC_ID.LENGTH);
  });

  it('should spread characters roughly uniformly over the alphabet', () => {
    const counts = new Map<string, number>();
    const samples = 2000;
    for (let i = 0; i < samples; i++) {
      for (const char of generatePublicId()) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }
    const expected = (samples * PUBLIC_ID.LENGTH) / PUBLIC_ID.ALPHABET.length;

    expect(counts.size).toBe(PUBLIC_ID.ALPHABET.length);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(expected * 0.7);
      expect(count).toBeLessThan(expected * 1.3);
    }
  });
});
