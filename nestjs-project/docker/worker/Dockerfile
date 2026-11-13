# Video worker image (phase-03-videos/TD-06, TD-07, TD-16).
# Same Node base as Dockerfile.dev, pinned by tag and digest.
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

# FFmpeg (ffmpeg + ffprobe) from Debian 13 "trixie", pinned to an exact
# package version. A newer Debian security release can retire this version
# from the mirror; the build then fails loudly and the pin must be raised
# deliberately (and the media fixtures of Gate 6 re-run).
ARG FFMPEG_VERSION=7:7.1.5-0+deb13u1
RUN apt-get update \
  && apt-get install -y --no-install-recommends "ffmpeg=${FFMPEG_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

# Non-root user without a login shell.
RUN groupadd --system --gid 10001 worker \
  && useradd --system --uid 10001 --gid worker --no-create-home \
     --shell /usr/sbin/nologin worker

WORKDIR /srv/app
USER worker

CMD ["node", "dist/worker/main.worker.js"]
