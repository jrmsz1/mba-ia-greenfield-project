# Verification Gate 6 — Real media fixtures (SI-03.13)

**Date:** 2026-11-12 · **Refs:** phase-03-videos/TD-07 (incl. revision 2026-11-11), TD-08, TD-13, TD-15 · **Result:** evidence executed for every scenario — PASS proposed, NOT yet approved

## Setup

- **Toolchain:** the worker image's pinned FFmpeg, Debian 13 package `7:7.1.5-0+deb13u1` (`ffmpeg`/`ffprobe 7.1.5-0+deb13u1`, SI-03.12). TD-07's evidence (E3/E5) was gathered on ffprobe 5.1.9. Every classification below was re-observed on 7.1.5.
- **Where it runs:** the API image is deliberately free of FFmpeg (TD-06), so the suite runs in the worker container: `docker compose run --rm --no-deps worker npm run test:media`. In `nestjs-api` the same file is reported as **skipped**, never as passed. `MEDIA_TOOLS_REQUIRED=1` turns a missing ffprobe into a failure.
- **Fixtures:** `nestjs-project/test/fixtures/media/generate.sh` generates synthetic 2 s / 160x120 clips with `testsrc`/`sine`. The suite runs the script into a temp dir; nothing binary is committed. The files are uploaded to the **test bucket** and probed through **real presigned GETs** of the pinned MinIO, the way the worker reads its input (TD-08).

## Evidence

Command: `docker compose run --rm --no-deps worker sh -c 'MEDIA_TOOLS_REQUIRED=1 npx jest --selectProjects integration --testPathPatterns src/media --verbose'` → **23 passed**. With the unit specs (`npm run test:media`) the total is **4 suites, 65 passed**.

| Fixture / scenario | Observed probe signal | Verdict |
|---|---|---|
| `h264-aac-faststart.mp4` | `mov,mp4,…` · `isom` · h264 yuv420p + aac · 2.0 s | accepted, metadata filled |
| `h264-no-audio.mp4` | h264 yuv420p, no audio | accepted (`audio: null`) |
| `h264-aac-moov-at-end.mp4` | moov at end, read over HTTP | accepted |
| `h264-brand-{mp42,mp41,avc1,iso2}.mp4` | major brand as named | accepted (brand allowlist backed by fixtures) |
| `mkv-saved-as.mp4` | `matroska,webm` | UNSUPPORTED_FORMAT |
| `quicktime.mov` | `mov,mp4,…` · brand `qt  ` | UNSUPPORTED_FORMAT |
| `clip.3gp` | `mov,mp4,…` · brand `3gp6` | UNSUPPORTED_FORMAT |
| `hevc.mp4` | codec `hevc` | UNSUPPORTED_FORMAT |
| `vp9.webm` | `matroska,webm`, `vp9` | UNSUPPORTED_FORMAT |
| `h264-yuv444p.mp4` | pix_fmt `yuv444p` | UNSUPPORTED_FORMAT |
| `h264-mp3-audio.mp4` | audio `mp3` | UNSUPPORTED_FORMAT |
| `truncated.mp4` (moov-at-end file cut in half) | "moov atom not found" (permanent) | UNSUPPORTED_FORMAT |
| `random-bytes.mp4`, `text.mp4` | "Invalid data found when processing input" (permanent) | UNSUPPORTED_FORMAT |
| `h264-6s.mp4`, ceiling overridden to 5 s | accepted format, 6.0 s | **DURATION_LIMIT_EXCEEDED** (not UNSUPPORTED_FORMAT); accepted with the default ceiling |
| Thumbnail | `-ss` at the policy position, 1 frame | JPEG (`ffd8ff`) written in a `streamtube-job-*` dir, dir gone afterwards |
| Failed probe inside the job dir | `text.mp4` | `MediaToolError` thrown; dir gone |
| Tampered `X-Amz-Signature` | "Server returned 403 Forbidden" | **transient**; message contains no `X-Amz-*` and not the signed URL |
| Probe timeout | server that accepts and never answers, `MEDIA_PROBE_TIMEOUT_SECONDS=2` | killed at ~2.0 s, **transient**, "timed out"; no `ffprobe` left in `/proc` |

Unit specs: `media-rule.spec.ts` (each acceptance/rejection rule on probe JSON, including the ceiling distinction and the exact-ceiling boundary), `thumbnail-policy.spec.ts` (position per duration; temp-dir removal on success and failure), `redact.spec.ts` (query string and `X-Amz-*` removed; stderr classification).

## Findings to review

- **A truncated MP4 with an intact header passes ffprobe** (`truncated-faststart.mp4` is accepted by the probe). This matches TD-07's E3 and its trade-off note. TD-07 assigns that case to the TD-02 size check (the declared size must equal the stored object) and to "a failed thumbnail decode is a processing failure". The test records it explicitly. The AC's "MP4 truncado" is the moov-at-end file cut in half, which the probe rejects.
- **Classification:** stderr patterns decide, never the exit code (TD-07). Network/storage signatures such as `Server returned 4xx/5xx`, connection refused/reset/timed out and DNS failure, plus timeouts, are transient. Anything else from the probe is permanent.
- **Allowlist completed by fixtures:** `isom` (TD-07 E5) plus `iso2`, `mp41`, `mp42` and `avc1`, each proven by a generated fixture. This is the plan's "isom, completada pelas fixtures". No TD change.
