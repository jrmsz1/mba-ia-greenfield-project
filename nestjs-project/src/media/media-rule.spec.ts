import type { ProbeResult, ProbeStream } from './ffprobe.runner';
import { evaluateMedia } from './media-rule';

const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2';
const H264: ProbeStream = {
  index: 0,
  codec_type: 'video',
  codec_name: 'h264',
  width: 160,
  height: 120,
  pix_fmt: 'yuv420p',
};
const AAC: ProbeStream = { index: 1, codec_type: 'audio', codec_name: 'aac' };

const probe = (
  overrides: {
    formatName?: string;
    brand?: string;
    duration?: string;
    streams?: ProbeStream[];
  } = {},
): ProbeResult => ({
  format: {
    format_name: overrides.formatName ?? MP4,
    duration: overrides.duration ?? '2.000000',
    size: '12345',
    bit_rate: '50000',
    tags: { major_brand: overrides.brand ?? 'isom' },
  },
  streams: overrides.streams ?? [H264, AAC],
});

const limits = { maxDurationSeconds: 14_400 };

describe('evaluateMedia', () => {
  it('accepts MP4 + H.264 yuv420p + AAC and fills container and stream metadata', () => {
    expect(evaluateMedia(probe(), limits)).toEqual({
      accepted: true,
      durationSeconds: 2,
      metadata: {
        format_name: MP4,
        major_brand: 'isom',
        video: {
          codec_name: 'h264',
          width: 160,
          height: 120,
          pix_fmt: 'yuv420p',
        },
        audio: { codec_name: 'aac' },
        bit_rate: 50000,
        size: 12345,
      },
    });
  });

  it('accepts H.264 without audio', () => {
    const verdict = evaluateMedia(probe({ streams: [H264] }), limits);

    expect(verdict).toMatchObject({
      accepted: true,
      metadata: { audio: null },
    });
  });

  it.each(['isom', 'iso2', 'mp41', 'mp42', 'avc1'])(
    'accepts the MP4-family brand %s',
    (brand) => {
      expect(evaluateMedia(probe({ brand }), limits).accepted).toBe(true);
    },
  );

  it.each([
    ['Matroska/WebM container', { formatName: 'matroska,webm' }],
    ['QuickTime brand', { brand: 'qt' }],
    ['3GP brand', { brand: '3gp6' }],
    ['missing brand', { brand: '' }],
    ['HEVC video', { streams: [{ ...H264, codec_name: 'hevc' }] }],
    ['VP9 video', { streams: [{ ...H264, codec_name: 'vp9' }] }],
    ['4:4:4 H.264', { streams: [{ ...H264, pix_fmt: 'yuv444p' }] }],
    ['MP3 audio', { streams: [H264, { ...AAC, codec_name: 'mp3' }] }],
    ['no video stream', { streams: [AAC] }],
    ['zero duration', { duration: '0.000000' }],
    ['missing duration', { duration: 'N/A' }],
  ])('rejects %s as UNSUPPORTED_FORMAT', (_label, overrides) => {
    expect(evaluateMedia(probe(overrides), limits)).toMatchObject({
      accepted: false,
      reason: 'UNSUPPORTED_FORMAT',
    });
  });

  it('rejects an empty probe as UNSUPPORTED_FORMAT', () => {
    expect(evaluateMedia({}, limits)).toMatchObject({
      reason: 'UNSUPPORTED_FORMAT',
    });
  });

  it('rejects an accepted format longer than the ceiling as DURATION_LIMIT_EXCEEDED, not UNSUPPORTED_FORMAT', () => {
    const verdict = evaluateMedia(probe({ duration: '6.0' }), {
      maxDurationSeconds: 5,
    });

    expect(verdict).toMatchObject({
      accepted: false,
      reason: 'DURATION_LIMIT_EXCEEDED',
    });
  });

  it('keeps UNSUPPORTED_FORMAT for a long file outside the accepted format', () => {
    const verdict = evaluateMedia(
      probe({ duration: '6.0', streams: [{ ...H264, codec_name: 'hevc' }] }),
      { maxDurationSeconds: 5 },
    );

    expect(verdict).toMatchObject({ reason: 'UNSUPPORTED_FORMAT' });
  });

  it('accepts a duration exactly at the ceiling', () => {
    expect(
      evaluateMedia(probe({ duration: '5' }), { maxDurationSeconds: 5 })
        .accepted,
    ).toBe(true);
  });
});
