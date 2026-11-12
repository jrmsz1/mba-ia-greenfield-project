import { createHash } from 'node:crypto';
import type { ManifestPart, ObjectHead } from '../storage/storage.service';

/**
 * Whether the pinned MinIO's final multipart ETag is a deterministic function
 * of the verified manifest (MD5 of the concatenated binary part MD5s + "-N").
 * Set from the executed Gate 4 evidence (docs/phases/phase-03-videos/gate-04-05-completion.md).
 * The multipart ETag is an opaque version token, never a content checksum
 * (phase-03-videos/TD-02); it is only an ADDITIONAL check when proven.
 */
export const FINAL_ETAG_IS_DETERMINISTIC = true;

export type ProofOutcome = 'proven' | 'contradicted' | 'unknown';

export interface ProofInput {
  /** HeadObject of the video's exclusive key, `null` when absent. */
  head: ObjectHead | null;
  declaredSizeBytes: number;
  bindingToken: string;
  /** Server-verified manifest (ListParts-checked), when available. */
  manifest?: ManifestPart[];
}

const unquote = (etag: string): string => etag.replace(/^"|"$/g, '');

/** MD5 of the concatenated binary part MD5s + "-N" (S3 multipart convention). */
export function expectedMultipartEtag(manifest: ManifestPart[]): string {
  const digests = manifest.map((part) =>
    Buffer.from(unquote(part.etag), 'hex'),
  );
  const md5 = createHash('md5').update(Buffer.concat(digests)).digest('hex');
  return `${md5}-${manifest.length}`;
}

/**
 * Completion proof of phase-03-videos/TD-02 (revision IC-1), evaluated on the
 * evidence storage returned. Required elements: the exclusive key and the
 * backend-stored upload id (implicit — the caller only inspects that key),
 * the server-verified manifest, the confirmed size and the `upload-binding`
 * metadata. Fail-safe: anything that cannot be established is `unknown`
 * (no transition); only positive contradictions are `contradicted`.
 */
export function evaluateCompletionProof(input: ProofInput): ProofOutcome {
  const { head } = input;
  if (head === null) return 'unknown';
  if (head.uploadBinding === undefined || head.etag === '') return 'unknown';
  return contradictionOf(input) === null ? 'proven' : 'contradicted';
}

/**
 * Which element positively contradicts the proof. The binding is checked
 * FIRST: a `size`/`etag` contradiction therefore implies the object carries
 * this upload's binding (its identity is proven), whereas `binding` means the
 * object at the key was NOT produced by this authorized upload.
 */
export type Contradiction = 'binding' | 'size' | 'etag';

export function contradictionOf(input: ProofInput): Contradiction | null {
  const { head } = input;
  if (head === null || head.uploadBinding === undefined) return null;
  if (head.uploadBinding !== input.bindingToken) return 'binding';
  if (head.contentLength !== input.declaredSizeBytes) return 'size';
  if (
    FINAL_ETAG_IS_DETERMINISTIC &&
    input.manifest &&
    unquote(head.etag) !== expectedMultipartEtag(input.manifest)
  ) {
    return 'etag';
  }
  return null;
}
