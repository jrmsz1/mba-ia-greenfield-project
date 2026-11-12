# Ephemeral MinIO admin client (mc) — used ONLY for idempotent provisioning,
# never part of the operational containers (SPIKE, phase-03 least privilege).
#
# The upstream images minio/mc (Docker Hub) and quay.io/minio/mc are not
# pullable anymore (verified 2026-11-12: "repository does not exist" / 401), so
# the client is built like the pinned server image: base pinned by digest, the
# release asset downloaded from GitHub and verified by SHA-256 at build time.
ARG DEBIAN_IMAGE=debian:12-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

FROM ${DEBIAN_IMAGE} AS download
ARG MC_RELEASE=RELEASE.2025-08-13T08-35-41Z
ARG MC_ARCH=amd64
# Published in mc.linux-amd64.<release>.sha256sum (the file names the asset
# `mc.RELEASE…`, so the hash — not the file name — is compared).
ARG MC_SHA256=01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /mc \
      "https://github.com/minio/mc/releases/download/${MC_RELEASE}/mc.linux-${MC_ARCH}.${MC_RELEASE}" \
  && echo "${MC_SHA256}  /mc" | sha256sum -c - \
  && chmod 0755 /mc

FROM ${DEBIAN_IMAGE}
COPY --from=download /mc /usr/local/bin/mc
RUN groupadd --system --gid 10002 mcadmin \
  && useradd --system --uid 10002 --gid mcadmin --create-home \
     --shell /usr/sbin/nologin mcadmin
USER mcadmin
WORKDIR /provision
ENTRYPOINT ["/bin/sh"]
