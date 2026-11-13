import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CompleteUploadDto } from './complete-upload.dto';

const HEX = 'a'.repeat(32);

const errorsFor = async (body: unknown): Promise<string[]> => {
  const errors = await validate(plainToInstance(CompleteUploadDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const flat: string[] = [];
  const walk = (list: typeof errors): void => {
    for (const e of list) {
      flat.push(...Object.keys(e.constraints ?? {}));
      walk(e.children ?? []);
    }
  };
  walk(errors);
  return flat;
};

describe('CompleteUploadDto', () => {
  it('accepts parts 1..N in ascending order with quoted, unquoted and suffixed ETags', async () => {
    expect(
      await errorsFor({
        parts: [
          { part_number: 1, etag: `"${HEX}"` },
          { part_number: 2, etag: HEX },
          { part_number: 3, etag: `"${HEX}-3"` },
        ],
      }),
    ).toEqual([]);
  });

  it.each([
    ['out of order', [2, 1]],
    ['not starting at 1', [2, 3]],
    ['with a gap', [1, 3]],
    ['with a duplicate', [1, 1]],
  ])('rejects part numbers %s', async (_label, numbers) => {
    const parts = numbers.map((n) => ({ part_number: n, etag: HEX }));

    expect(await errorsFor({ parts })).toContain('isAscendingFromOne');
  });

  it('rejects a malformed ETag', async () => {
    expect(
      await errorsFor({ parts: [{ part_number: 1, etag: 'not-an-etag' }] }),
    ).toContain('matches');
  });

  it('rejects an empty or missing parts list', async () => {
    expect(await errorsFor({ parts: [] })).toContain('arrayMinSize');
    expect(await errorsFor({})).toContain('isArray');
  });

  it('rejects unknown fields inside a part', async () => {
    expect(
      await errorsFor({ parts: [{ part_number: 1, etag: HEX, size: 1 }] }),
    ).toContain('whitelistValidation');
  });
});
