# Verification Gate 2 — Pinned MinIO image (SI-03.3)

**Date:** 2026-11-11 · **Refs:** phase-03-videos/TD-03, TD-16 · **Result:** PASS (evidence executed; see below)

## Image

- `nestjs-project/docker/minio/Dockerfile`: base `debian:12-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc`; release `RELEASE.2025-09-07T16-13-09Z`; asset `minio.linux-amd64.RELEASE.2025-09-07T16-13-09Z` from the GitHub release.
- The expected SHA-256 `7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f` matches the release's published checksum file. That file names the asset `minio.RELEASE…`, so the build compares the hash, not the file name.
- Non-root user `minio` (uid 999), shell `/usr/sbin/nologin`, `VOLUME /data`, `HEALTHCHECK` on `/minio/health/ready`, credentials only from `.env`.
- Compose service `minio` (ports 9000/9001, volume `minio-data`); `nestjs-api` depends on it with `condition: service_healthy`.

## Evidence (commands run from `nestjs-project/`)

| Check | Command | Observed |
|---|---|---|
| Tampered checksum fails the build | `docker build --no-cache --build-arg MINIO_SHA256=000…000 docker/minio` | fails at `sha256sum -c -`, exit code 1 |
| Pinned build succeeds | `docker compose build minio` | image built |
| Health | `docker compose up -d minio`; `docker inspect -f '{{.State.Health.Status}}'` | `healthy` |
| Readiness from the host | `curl -fsS http://localhost:9000/minio/health/ready` | HTTP 200 |
| Documented readiness check | `docker compose exec minio curl -fsS http://localhost:9000/minio/health/ready` | exit code 0 |
| Non-root | `docker compose exec minio id` | `uid=999(minio) gid=999(minio)` |
| CORS preflight, allowed origin | `OPTIONS` with `Origin: http://localhost:3001`, `Access-Control-Request-Method: PUT` | `204`, `Access-Control-Allow-Origin: http://localhost:3001`, `Allow-Methods: PUT` |
| `ETag` readable by a browser | SigV4 `PUT` with `Origin: http://localhost:3001` | `200`, `ETag` present, `Access-Control-Expose-Headers` includes `Etag` |
| Foreign origin | `OPTIONS` with `Origin: http://evil.example` | no `Access-Control-Allow-Origin` header (the browser blocks it) |

The temporary bucket `gate2-cors-check` was deleted after the checks.

## Preserved options not exercised

- **minisign** verification: implemented behind `--build-arg MINIO_MINISIGN_PUBKEY=<key from the tag's Dockerfile.release>`. Not run, because the public key is not stored in the repository.
- **ARM64 asset**: documented in the Dockerfile header (`MINIO_ARCH=arm64` + its checksum). Not run, because the host is amd64.
