#!/bin/sh
# Reproducible media fixtures for the accepted-format rule (phase-03-videos/TD-07,
# TD-15, Verification Gate 6). Requires the worker image's pinned ffmpeg:
#   docker compose run --rm --no-deps worker sh test/fixtures/media/generate.sh <out-dir>
# Every clip is synthetic (testsrc / sine), 2 s, 160x120: small and license-free.
# Names state what the file IS; the extension deliberately lies for some.
set -eu

OUT="${1:-test/fixtures/media/out}"
mkdir -p "$OUT"

FF="ffmpeg -nostdin -v error -y"
V="-f lavfi -i testsrc=duration=2:size=160x120:rate=25"
A="-f lavfi -i sine=frequency=440:duration=2"
H264="-c:v libx264 -preset ultrafast -pix_fmt yuv420p"

# --- accepted ---
$FF $V $A $H264 -c:a aac -shortest -movflags +faststart "$OUT/h264-aac-faststart.mp4"
$FF $V $H264 -an "$OUT/h264-no-audio.mp4"
# Default mp4 muxing writes the moov atom at the END (no faststart).
$FF $V $A $H264 -c:a aac -shortest "$OUT/h264-aac-moov-at-end.mp4"
# MP4-family major brands other than isom (allowlist completed by fixtures).
for brand in mp42 mp41 avc1 iso2; do
  $FF $V $H264 -an -brand "$brand" "$OUT/h264-brand-$brand.mp4"
done
# A longer accepted clip for the duration ceiling (with a small override).
$FF -f lavfi -i testsrc=duration=6:size=160x120:rate=25 $H264 -an "$OUT/h264-6s.mp4"

# --- rejected (UNSUPPORTED_FORMAT) ---
$FF $V -c:v libx265 -preset ultrafast -x265-params log-level=error -pix_fmt yuv420p -tag:v hvc1 -an "$OUT/hevc.mp4"
$FF $V -c:v libvpx-vp9 -deadline realtime -an -f webm "$OUT/vp9.webm"
$FF $V $H264 -an -f matroska "$OUT/mkv-saved-as.mp4"
$FF $V $H264 -an -f mov "$OUT/quicktime.mov"
$FF $V $H264 -an -f 3gp "$OUT/clip.3gp"
$FF $V -c:v libx264 -preset ultrafast -pix_fmt yuv444p -an "$OUT/h264-yuv444p.mp4"
$FF $V $A $H264 -c:a libmp3lame -shortest "$OUT/h264-mp3-audio.mp4"
# Truncated: the moov-at-end file cut in half loses its moov atom.
size=$(wc -c < "$OUT/h264-aac-moov-at-end.mp4")
head -c $((size / 2)) "$OUT/h264-aac-moov-at-end.mp4" > "$OUT/truncated.mp4"
# Header intact, data cut (passes ffprobe; covered by TD-02 size + thumbnail).
size=$(wc -c < "$OUT/h264-aac-faststart.mp4")
head -c $((size / 2)) "$OUT/h264-aac-faststart.mp4" > "$OUT/truncated-faststart.mp4"
head -c 65536 /dev/urandom > "$OUT/random-bytes.mp4"
printf 'this is not a video\n' > "$OUT/text.mp4"

ls -1 "$OUT"
