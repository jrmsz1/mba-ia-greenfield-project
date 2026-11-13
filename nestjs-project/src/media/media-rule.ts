import { FAILURE_REASONS, type MediaMetadata } from '../videos/video.constants';
import type { ProbeResult } from './ffprobe.runner';
import { MEDIA_RULE } from './media.constants';

export type MediaVerdict =
  | { accepted: true; durationSeconds: number; metadata: MediaMetadata }
  | {
      accepted: false;
      reason:
        | typeof FAILURE_REASONS.UNSUPPORTED_FORMAT
        | typeof FAILURE_REASONS.DURATION_LIMIT_EXCEEDED;
      detail: string;
    };

const unsupported = (detail: string): MediaVerdict => ({
  accepted: false,
  reason: FAILURE_REASONS.UNSUPPORTED_FORMAT,
  detail,
});

const toNumber = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Accepted-format rule of phase-03-videos/TD-07 (human decision), decided
 * from the probe only — never from the file extension or the declared MIME:
 * MP4 container (format_name contains `mp4`) with an MP4-family major brand,
 * first video stream H.264 yuv420p, audio absent or AAC, duration > 0.
 * Anything outside it is UNSUPPORTED_FORMAT. A file INSIDE it whose duration
 * exceeds the ceiling is DURATION_LIMIT_EXCEEDED (TD-07 revision 2026-11-11).
 * Both are permanent.
 */
export function evaluateMedia(
  probe: ProbeResult,
  limits: { maxDurationSeconds: number },
): MediaVerdict {
  const format = probe.format ?? {};
  const formatName = format.format_name ?? '';
  const brand = format.tags?.major_brand?.trim() ?? '';
  if (!formatName.split(',').includes(MEDIA_RULE.FORMAT_NAME_TOKEN)) {
    return unsupported(`container ${formatName || 'unknown'}`);
  }
  if (!(MEDIA_RULE.MAJOR_BRANDS as readonly string[]).includes(brand)) {
    return unsupported(`major brand ${brand || 'missing'}`);
  }

  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) return unsupported('no video stream');
  if (video.codec_name !== MEDIA_RULE.VIDEO_CODEC) {
    return unsupported(`video codec ${video.codec_name ?? 'unknown'}`);
  }
  if (video.pix_fmt !== MEDIA_RULE.PIX_FMT) {
    return unsupported(`pixel format ${video.pix_fmt ?? 'unknown'}`);
  }
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (audio && audio.codec_name !== MEDIA_RULE.AUDIO_CODEC) {
    return unsupported(`audio codec ${audio.codec_name ?? 'unknown'}`);
  }
  const duration = toNumber(format.duration);
  if (duration === null || duration <= 0) {
    return unsupported('duration missing or not positive');
  }

  // Accepted format from here on: only the ceiling can still reject it.
  if (duration > limits.maxDurationSeconds) {
    return {
      accepted: false,
      reason: FAILURE_REASONS.DURATION_LIMIT_EXCEEDED,
      detail: `duration ${duration}s exceeds ${limits.maxDurationSeconds}s`,
    };
  }
  return {
    accepted: true,
    durationSeconds: duration,
    metadata: {
      format_name: formatName,
      major_brand: brand,
      video: {
        codec_name: video.codec_name,
        width: video.width ?? 0,
        height: video.height ?? 0,
        pix_fmt: video.pix_fmt,
      },
      audio: audio ? { codec_name: MEDIA_RULE.AUDIO_CODEC } : null,
      bit_rate: toNumber(format.bit_rate),
      size: toNumber(format.size),
    },
  };
}
