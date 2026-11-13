import { createHash } from 'node:crypto';
import type { ManifestPart, ObjectHead } from '../storage/storage.service';
import {
  contradictionOf,
  evaluateCompletionProof,
  expectedMultipartEtag,
} from './completion-proof';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const manifest: ManifestPart[] = [
  { partNumber: 1, etag: `"${md5('a')}"` },
  { partNumber: 2, etag: `"${md5('b')}"` },
];
const SIZE = 1234;
const TOKEN = 'binding-token';
const head = (overrides: Partial<ObjectHead> = {}): ObjectHead => ({
  contentLength: SIZE,
  etag: `"${expectedMultipartEtag(manifest)}"`,
  uploadBinding: TOKEN,
  ...overrides,
});
const proof = (h: ObjectHead | null, withManifest = true) =>
  evaluateCompletionProof({
    head: h,
    declaredSizeBytes: SIZE,
    bindingToken: TOKEN,
    manifest: withManifest ? manifest : undefined,
  });

describe('evaluateCompletionProof', () => {
  it('computes the multipart ETag as MD5 of the binary part MD5s plus the part count', () => {
    const expected = createHash('md5')
      .update(Buffer.from(md5('a') + md5('b'), 'hex'))
      .digest('hex');

    expect(expectedMultipartEtag(manifest)).toBe(`${expected}-2`);
  });

  it('is proven when binding, size and final ETag all match', () => {
    expect(proof(head())).toBe('proven');
  });

  it('is proven without a manifest when binding and size match', () => {
    expect(proof(head({ etag: '"other-2"' }), false)).toBe('proven');
  });

  it('is unknown when no object exists at the key', () => {
    expect(proof(null)).toBe('unknown');
  });

  it('is contradicted when a successful HeadObject shows no binding metadata (identity unproven)', () => {
    expect(proof(head({ uploadBinding: undefined }))).toBe('contradicted');
    expect(proof(head({ uploadBinding: '' }))).toBe('contradicted');
  });

  it('is unknown for an inconclusive read (no ETag), even without a binding', () => {
    expect(proof(head({ etag: '' }))).toBe('unknown');
    expect(proof(head({ etag: '', uploadBinding: undefined }))).toBe('unknown');
  });

  it('is contradicted by another upload binding', () => {
    expect(proof(head({ uploadBinding: 'someone-else' }))).toBe('contradicted');
  });

  it('is contradicted by a different size', () => {
    expect(proof(head({ contentLength: SIZE + 1 }))).toBe('contradicted');
  });

  it('is contradicted by a final ETag that does not derive from the verified manifest', () => {
    expect(proof(head({ etag: '"deadbeef-2"' }))).toBe('contradicted');
  });
});

describe('contradictionOf', () => {
  const of = (h: ObjectHead | null) =>
    contradictionOf({
      head: h,
      declaredSizeBytes: SIZE,
      bindingToken: TOKEN,
      manifest,
    });

  it('reports the binding FIRST, even when size and ETag also differ', () => {
    expect(
      of(
        head({
          uploadBinding: 'someone-else',
          contentLength: SIZE + 1,
          etag: '"deadbeef-2"',
        }),
      ),
    ).toBe('binding');
  });

  it('reports size, then ETag, only for an object that carries this binding', () => {
    expect(of(head({ contentLength: SIZE + 1 }))).toBe('size');
    expect(of(head({ etag: '"deadbeef-2"' }))).toBe('etag');
  });

  it('reports a MISSING binding as a binding contradiction', () => {
    expect(of(head({ uploadBinding: undefined }))).toBe('binding');
  });

  it('reports nothing for a proven object, a missing object or an inconclusive read', () => {
    expect(of(head())).toBeNull();
    expect(of(null)).toBeNull();
    expect(of(head({ etag: '' }))).toBeNull();
  });
});
