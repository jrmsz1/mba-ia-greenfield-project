#!/usr/bin/env bash
# StreamTube — external test-storage maintenance (phase-03-videos/TD-15).
#
#   ./scripts/test-storage-maintenance.sh            dry run: counts only
#   ./scripts/test-storage-maintenance.sh --confirm  remove objects and abort
#                                                    multipart sessions of
#                                                    S3_TEST_BUCKET only
#
# Never run automatically. Runs in a one-off container (not a Compose service,
# not nestjs-api/worker) with only the maintenance identity (maintenance.env);
# the tool refuses any other bucket, root or operational credentials, and any
# moment a test run holds the test-run lock.
set -euo pipefail

ARGS=()
case "${1:-}" in
  "") ;;
  --confirm) ARGS=(--confirm) ;;
  *) echo "Unknown option: $1 (use --confirm)" >&2; exit 2 ;;
esac

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$REPO/nestjs-project"
SECRETS="$REPO/.local/secrets"
export MSYS_NO_PATHCONV=1
get() { sed -n "s/^$1=//p" "$BACKEND/.env" | head -n 1 | tr -d '\r'; }
host_path() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
BACKEND_HOST="$(host_path "$BACKEND")"
compose() { docker compose --project-directory "$BACKEND_HOST" -f "$BACKEND_HOST/compose.yaml" "$@"; }

[ -f "$SECRETS/maintenance.env" ] || { echo "maintenance.env not found — run ./scripts/setup.sh first" >&2; exit 1; }
SECRETS_HOST="$(host_path "$SECRETS")"
MINIO_ID="$(compose ps -q minio)"
API_ID="$(compose ps -q nestjs-api)"
[ -n "$MINIO_ID" ] && [ -n "$API_ID" ] || { echo "the stack is not running — run ./scripts/setup.sh first" >&2; exit 1; }
PROJECT="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$MINIO_ID")"
IMAGE="$(docker inspect -f '{{ .Config.Image }}' "$API_ID")"

docker run --rm --network "${PROJECT}_default" \
  --env-file "$SECRETS_HOST/maintenance.env" \
  -e STREAMTUBE_TEST_MAINTENANCE=1 \
  -e S3_ENDPOINT=http://minio:9000 \
  -e S3_BUCKET="$(get S3_BUCKET)" -e S3_TEST_BUCKET="$(get S3_TEST_BUCKET)" \
  -e DB_HOST=db -e DB_PORT=5432 \
  -e DB_USERNAME="$(get DB_USERNAME)" -e DB_PASSWORD="$(get DB_PASSWORD)" \
  -e DB_TEST_NAME="$(get DB_TEST_NAME)" -e DB_TEST_SERVER_ID="$(get DB_TEST_SERVER_ID)" \
  -v "$BACKEND_HOST:/home/node/app" -w /home/node/app \
  "$IMAGE" npx ts-node --transpile-only src/test/storage-maintenance.ts "${ARGS[@]+"${ARGS[@]}"}"
