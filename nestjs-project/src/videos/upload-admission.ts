import { ABUSE_LIMITS } from './abuse-limits';
import {
  ActiveUploadLimitExceededException,
  PendingUploadQuotaExceededException,
  UploadStartRateExceededException,
} from './video.exceptions';

export interface OwnerUsage {
  /** Uploads in `uploading`/`completing` across the owner's channels. */
  activeUploads: number;
  /** Sum of their declared sizes. */
  pendingBytes: number;
  /** Videos created by the owner in the last hour. */
  startsLastHour: number;
}

export interface AdmissionLimits {
  maxActiveUploadsPerOwner: number;
  maxPendingUploadBytesPerOwner: number;
}

/**
 * Decides whether one more upload of `sizeBytes` is admitted for an owner
 * (phase-03-videos/TD-13 revision AMB-2). Throws the first violated limit.
 */
export function assertUploadAdmitted(
  usage: OwnerUsage,
  sizeBytes: number,
  limits: AdmissionLimits,
): void {
  if (usage.startsLastHour >= ABUSE_LIMITS.UPLOAD_STARTS_PER_HOUR) {
    throw new UploadStartRateExceededException(
      ABUSE_LIMITS.UPLOAD_STARTS_PER_HOUR,
    );
  }
  if (usage.activeUploads >= limits.maxActiveUploadsPerOwner) {
    throw new ActiveUploadLimitExceededException(
      limits.maxActiveUploadsPerOwner,
    );
  }
  if (usage.pendingBytes + sizeBytes > limits.maxPendingUploadBytesPerOwner) {
    throw new PendingUploadQuotaExceededException(
      limits.maxPendingUploadBytesPerOwner,
    );
  }
}

/** Strips path segments and control characters; never empty (TD-13). */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const clean = [...base]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && code !== 0x7f; // drop C0 control characters and DEL
    })
    .join('')
    .trim();
  const safe =
    clean === '' || clean === '.' || clean === '..' ? 'video' : clean;
  return safe.slice(0, 255);
}

/** Part size and count for a declared size (phase-03-videos/TD-01). */
export function planParts(
  sizeBytes: number,
  partSizeBytes: number,
): { partSizeBytes: number; expectedPartCount: number } {
  return {
    partSizeBytes,
    expectedPartCount: Math.max(1, Math.ceil(sizeBytes / partSizeBytes)),
  };
}
