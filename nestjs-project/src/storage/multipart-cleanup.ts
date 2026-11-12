import { StorageError, UploadNotFoundError } from './storage-errors';
import { CLEANUP_LIMITS } from './storage.constants';
import type { StorageService } from './storage.service';

/**
 * - `aborted`: every session of the key answers `NoSuchUpload` and no object exists;
 * - `completed`: an object exists and carries this session's binding token;
 * - `indeterminate`: anything else (errors, attempts exhausted, foreign object).
 */
export type CleanupOutcome = 'aborted' | 'completed' | 'indeterminate';

export interface CleanupOptions {
  maxAbortAttempts?: number;
  backoffMs?: number;
}

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

async function abortUntilGone(
  storage: StorageService,
  key: string,
  uploadId: string,
  maxAttempts: number,
  backoffMs: number,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await storage.abortMultipartUpload(key, uploadId);
    } catch (error) {
      if (!(error instanceof UploadNotFoundError)) throw error;
    }
    try {
      await storage.listParts(key, uploadId);
    } catch (error) {
      if (error instanceof UploadNotFoundError) return true;
      throw error;
    }
    // Parts still in transit can keep the upload alive: abort again.
    await sleep(backoffMs * attempt);
  }
  return false;
}

/**
 * Proves that no multipart session of the video's exclusive key is left open
 * before capacity is released or a row becomes `expired`/`cancelled`
 * (phase-03-videos plan, SI-03.4 action 4; TD-02, TD-14). An empty
 * `ListMultipartUploads` result alone is never accepted as proof.
 */
export async function confirmUploadsGone(
  storage: StorageService,
  key: string,
  knownUploadIds: string[],
  bindingToken: string,
  options: CleanupOptions = {},
): Promise<CleanupOutcome> {
  const maxAttempts =
    options.maxAbortAttempts ?? CLEANUP_LIMITS.MAX_ABORT_ATTEMPTS;
  const backoffMs = options.backoffMs ?? CLEANUP_LIMITS.BACKOFF_MS;
  try {
    const listed = await storage.listMultipartUploads(key);
    const sessions = [...new Set([...knownUploadIds, ...listed])];
    for (const uploadId of sessions) {
      const gone = await abortUntilGone(
        storage,
        key,
        uploadId,
        maxAttempts,
        backoffMs,
      );
      if (!gone) return 'indeterminate';
    }

    const head = await storage.headObject(key);
    if (head === null) return 'aborted';
    return head.uploadBinding === bindingToken ? 'completed' : 'indeterminate';
  } catch (error) {
    if (error instanceof StorageError) return 'indeterminate';
    throw error;
  }
}
