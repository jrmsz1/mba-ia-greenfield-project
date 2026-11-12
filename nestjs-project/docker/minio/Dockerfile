# Pinned MinIO server image (phase-03-videos/TD-03, Verification Gate 2).
#
# The binary comes from the GitHub release asset (dl.min.io answers 410 for
# this release) and the build FAILS unless its SHA-256 equals MINIO_SHA256.
# The published checksum file names the asset "minio.RELEASE…", so the build
# compares the hash, not the file name.
#
# ARM64 hosts: pass the arm64 asset and its checksum, e.g.
#   docker compose build --build-arg MINIO_ARCH=arm64 --build-arg MINIO_SHA256=<arm64 sha256> minio
# (take the value from the release's minio.linux-arm64.<release>.sha256sum).
#
# Optional minisign verification: pass MINIO_MINISIGN_PUBKEY (the public key
# published in the tag's Dockerfile.release) to also verify the .minisig file.
ARG DEBIAN_IMAGE=debian:12-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
FROM ${DEBIAN_IMAGE}

ARG MINIO_RELEASE=RELEASE.2025-09-07T16-13-09Z
ARG MINIO_ARCH=amd64
ARG MINIO_SHA256=7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f
ARG MINIO_MINISIGN_PUBKEY=

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && if [ -n "${MINIO_MINISIGN_PUBKEY}" ]; then apt-get install -y --no-install-recommends minisign; fi \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    asset="minio.linux-${MINIO_ARCH}.${MINIO_RELEASE}"; \
    base="https://github.com/minio/minio/releases/download/${MINIO_RELEASE}"; \
    curl -fsSL --retry 3 -o /usr/local/bin/minio "${base}/${asset}"; \
    echo "${MINIO_SHA256}  /usr/local/bin/minio" | sha256sum -c -; \
    if [ -n "${MINIO_MINISIGN_PUBKEY}" ]; then \
      curl -fsSL --retry 3 -o /tmp/minio.minisig "${base}/${asset}.minisig"; \
      minisign -Vm /usr/local/bin/minio -x /tmp/minio.minisig -P "${MINIO_MINISIGN_PUBKEY}"; \
      rm -f /tmp/minio.minisig; \
    fi; \
    chmod 0755 /usr/local/bin/minio

RUN groupadd --system minio \
 && useradd --system --gid minio --home-dir /data --shell /usr/sbin/nologin minio \
 && mkdir -p /data \
 && chown minio:minio /data

USER minio
VOLUME /data
EXPOSE 9000 9001

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD curl -fsS http://localhost:9000/minio/health/ready || exit 1

ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
