import { registerAs } from '@nestjs/config';
import { envInt } from './video.constants';

/** Media worker limits (phase-03-videos/TD-05, TD-06, TD-07, TD-08). */
export default registerAs('worker', () => ({
  concurrency: envInt('WORKER_CONCURRENCY'),
  jobTimeoutSeconds: envInt('WORKER_JOB_TIMEOUT_SECONDS'),
  mediaProbeTimeoutSeconds: envInt('MEDIA_PROBE_TIMEOUT_SECONDS'),
  maxVideoDurationSeconds: envInt('MAX_VIDEO_DURATION_SECONDS'),
  processingInputPresignTtlSeconds: envInt(
    'PROCESSING_INPUT_PRESIGN_TTL_SECONDS',
  ),
}));
