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
 * metadata. Fail-safe: what cannot be established is `unknown` (no
 * transition) — no object yet, or an inconclusive read (no ETag). A storage
 * failure never reaches this function: callers catch it and stay pending.
 * Only positive contradictions are `contradicted`. A SUCCESSFUL HeadObject
 * whose `upload-binding` is missing or different is a positive identity
 * contradiction (phase-03-videos/TD-02 and TD-09 revisions of 2026-11-12).
 */
export function evaluateCompletionProof(input: ProofInput): ProofOutcome {
  const { head } = input;
  if (head === null || head.etag === '') return 'unknown';
  return contradictionOf(input) === null ? 'proven' : 'contradicted';
}

/**
 * Which element positively contradicts the proof. The binding is checked
 * FIRST: a `size`/`etag` contradiction therefore implies the object carries
 * this upload's binding (its identity is proven), whereas `binding` — the
 * metadata is missing or differs — means the object at the key was NOT proven
 * to come from this authorized upload: it is never deleted automatically.
 */
export type Contradiction = 'binding' | 'size' | 'etag';

export function contradictionOf(input: ProofInput): Contradiction | null {
  const { head } = input;
  if (head === null || head.etag === '') return null;
  if (!head.uploadBinding || head.uploadBinding !== input.bindingToken) {
    return 'binding';
  }
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
