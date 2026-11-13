import { registerAs } from '@nestjs/config';
import { envInt } from './video.constants';

/** Upload limits, TTLs and per-owner quotas (phase-03-videos/TD-01, TD-11, TD-13, TD-14). */
export default registerAs('upload', () => ({
  maxUploadBytes: envInt('MAX_UPLOAD_BYTES'),
  partSizeBytes: envInt('UPLOAD_PART_SIZE_BYTES'),
  expiryHours: envInt('UPLOAD_EXPIRY_HOURS'),
  partPresignTtlSeconds: envInt('UPLOAD_PART_PRESIGN_TTL_SECONDS'),
  playbackPresignTtlSeconds: envInt('PLAYBACK_PRESIGN_TTL_SECONDS'),
  downloadPresignTtlSeconds: envInt('DOWNLOAD_PRESIGN_TTL_SECONDS'),
  completingStaleMinutes: envInt('COMPLETING_STALE_MINUTES'),
  maxActiveUploadsPerOwner: envInt('MAX_ACTIVE_UPLOADS_PER_OWNER'),
  maxPendingUploadBytesPerOwner: envInt('MAX_PENDING_UPLOAD_BYTES_PER_OWNER'),
}));
