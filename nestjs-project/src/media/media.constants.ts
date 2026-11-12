/**
 * Fixed limits of the media tools (phase-03-videos/TD-07, TD-08). The wall
 * clock timeout comes from MEDIA_PROBE_TIMEOUT_SECONDS (worker config).
 */
export const MEDIA_TOOLS = {
  FFPROBE_BIN: 'ffprobe',
  FFMPEG_BIN: 'ffmpeg',
  /** Per I/O operation, in MICROseconds (FFmpeg protocol option). */
  RW_TIMEOUT_MICROSECONDS: 15_000_000,
  /** Format probing bounds (bytes / microseconds). */
  PROBESIZE_BYTES: 10_000_000,
  ANALYZEDURATION_MICROSECONDS: 10_000_000,
  /** Output caps: a runaway tool cannot exhaust worker memory. */
  MAX_STDOUT_BYTES: 1_048_576,
  MAX_STDERR_BYTES: 65_536,
  /** JPEG quality scale of `-q:v` (2 = high). */
  THUMBNAIL_QUALITY: 2,
} as const;

/** Accepted-format rule (phase-03-videos/TD-07, human decision). */
export const MEDIA_RULE = {
  FORMAT_NAME_TOKEN: 'mp4',
  /**
   * MP4-family major brands, each backed by a fixture of
   * test/fixtures/media/generate.sh. MOV (`qt  `) and 3GP (`3gp6`) share the
   * same format_name and are rejected by brand.
   */
  MAJOR_BRANDS: ['isom', 'iso2', 'mp41', 'mp42', 'avc1'],
  VIDEO_CODEC: 'h264',
  PIX_FMT: 'yuv420p',
  AUDIO_CODEC: 'aac',
} as const;

/** Thumbnail position policy (phase-03-videos/TD-07). */
export const THUMBNAIL_POLICY = {
  FRACTION: 0.1,
  MIN_SECONDS: 1,
  MAX_SECONDS: 10,
  /** Clips shorter than this use the first frame. */
  SHORT_CLIP_SECONDS: 2,
} as const;

export const JOB_TEMP_DIR_PREFIX = 'streamtube-job-';
