#!/usr/bin/env bash
# StreamTube — verification (Linux/macOS; also Git Bash on Windows).
#
#   ./scripts/verify.sh          quick: health, credential isolation of every
#                                container, essential storage/upload/streaming/
#                                processing suites (a few minutes)
#   ./scripts/verify.sh --full   full regression: unit + integration, e2e,
#                                media (FFmpeg), tsc --noEmit, eslint
#
# Every suite runs in an ephemeral test container (compose.test.yaml,
# `run --rm`): only the test database, S3_TEST_BUCKET, the test queue schema
# and the restricted test identities. Variable NAMES are inspected, never
# values. The 10 GiB verification is separate and never runs here.
set -uo pipefail

FULL=0
case "${1:-}" in
  "") ;;
  --full) FULL=1 ;;
  -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
  *) echo "Unknown option: $1 (use --full or --help)" >&2; exit 2 ;;
esac

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$REPO/nestjs-project"
# Git Bash on Windows: no path conversion; Docker/git get Windows-form paths.
export MSYS_NO_PATHCONV=1
host_path() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
REPO_HOST="$(host_path "$REPO")"
BACKEND_HOST="$(host_path "$BACKEND")"
compose() { docker compose --project-directory "$BACKEND_HOST" -f "$BACKEND_HOST/compose.yaml" "$@"; }
compose_test() { docker compose --project-directory "$BACKEND_HOST" -f "$BACKEND_HOST/compose.yaml" -f "$BACKEND_HOST/compose.test.yaml" "$@"; }

PASS=0
FAIL=0
RESULTS=()
record() { # status label
  if [ "$1" = PASS ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
  RESULTS+=("$1  $2")
  printf '    %s  %s\n' "$1" "$2"
}
check() { # label command...
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then record PASS "$label"; else record FAIL "$label"; fi
}
# A failing suite keeps its complete output in .local/verify-logs/ (git-ignored,
# outside the bind mount). Output is redacted before it is written or shown:
# every value of the local credential files (exact match), presigned URL
# signature parameters and bearer tokens.
LOG_DIR="$REPO/.local/verify-logs"
redact() {
  awk -v secrets="$REPO/.local/secrets" '
    BEGIN {
      n = 0
      cmd = "cat \"" secrets "\"/*.env 2>/dev/null"
      while ((cmd | getline line) > 0) {
        sub(/\r$/, "", line)
        i = index(line, "=")
        if (i > 1 && line !~ /^[[:space:]]*#/) { v = substr(line, i + 1); if (length(v) >= 8) s[++n] = v }
      }
      close(cmd)
    }
    {
      for (k = 1; k <= n; k++) {
        while ((p = index($0, s[k])) > 0) $0 = substr($0, 1, p - 1) "<redacted>" substr($0, p + length(s[k]))
      }
      gsub(/X-Amz-Signature=[^&[:space:]"]*/, "X-Amz-Signature=<redacted>")
      gsub(/X-Amz-Credential=[^&[:space:]"]*/, "X-Amz-Credential=<redacted>")
      gsub(/X-Amz-Security-Token=[^&[:space:]"]*/, "X-Amz-Security-Token=<redacted>")
      gsub(/Bearer [A-Za-z0-9._~+\/=-]+/, "Bearer <redacted>")
      print
    }'
}
run_suite() { # label service command...
  local label="$1" service="$2"; shift 2
  local log
  log="$(mktemp)"
  printf '    ...  %s\n' "$label"
  if compose_test run --rm "$service" "$@" >"$log" 2>&1; then
    local tests
    tests="$(grep -E '^Tests:' "$log" | tail -n 1 | sed 's/^Tests: *//')"
    record PASS "$label${tests:+ ($tests)}"
  else
    local slug saved
    slug="$(printf '%s' "$label" | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9' '-' | sed 's/^-//; s/-$//' | cut -c1-60)"
    saved="$LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$slug.log"
    (umask 077 && mkdir -p "$LOG_DIR" && redact <"$log" >"$saved") || saved=""
    record FAIL "$label — last lines:"
    redact <"$log" | tail -n 25 | sed 's/^/          /'
    if [ -n "$saved" ]; then
      printf '          full log (redacted): %s\n' "$saved"
    else
      printf '          (the full log could not be saved)\n'
    fi
  fi
  rm -f "$log"
}

# Credential variable names of a container's environment, including what the
# app would load from the mounted .env (dotenv does not override real env).
CRED_RE='^(MINIO_ROOT_|S3_ACCESS_KEY_ID$|S3_SECRET_ACCESS_KEY$|S3_DELIVERY_|S3_API_|S3_WORKER_|S3_TEST_(API|WORKER|DELIVERY|MAINTENANCE)_)'
names_running() { compose exec -T "$1" sh -c 'env | cut -d= -f1' | tr -d '\r' | grep -E "$CRED_RE" | LC_ALL=C sort -u; }
names_test() { compose_test run --rm --no-deps -T "$1" sh -c 'env | cut -d= -f1' | tr -d '\r' | grep -E "$CRED_RE" | LC_ALL=C sort -u; }
names_dotenv() { grep -E '^[A-Z0-9_]+=.+' "$BACKEND/.env" | cut -d= -f1 | grep -E "$CRED_RE" | LC_ALL=C sort -u; }
expect_names() { # label actual-names expected-names
  if [ "$2" = "$3" ]; then record PASS "$1"; else record FAIL "$1 (got: ${2:-none}; expected: ${3:-none})"; fi
}

printf '==> Services and health\n'
check "PostgreSQL accepts connections" compose exec -T db pg_isready -U streamtube
check "MinIO is ready" compose exec -T minio curl -fsS http://localhost:9000/minio/health/ready
check "API answers" compose exec -T nestjs-api curl -fsS http://localhost:3000/
worker_ok() { [ -n "$(compose ps --status running -q worker)" ] && case "$(compose logs worker 2>/dev/null)" in *'Video worker started'*) true ;; *) false ;; esac; }
check "worker running and connected to the queue" worker_ok

printf '\n==> Credential isolation (variable names only)\n'
expect_names "nestjs-api: only the API and delivery identities" "$(names_running nestjs-api | tr '\n' ' ')" \
  "S3_ACCESS_KEY_ID S3_DELIVERY_ACCESS_KEY_ID S3_DELIVERY_SECRET_ACCESS_KEY S3_SECRET_ACCESS_KEY "
expect_names "worker: only the worker identity" "$(names_running worker | tr '\n' ' ')" \
  "S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY "
expect_names "mounted .env: no credential" "$(names_dotenv | tr '\n' ' ')" ""
TEST_NAMES="S3_TEST_API_ACCESS_KEY_ID S3_TEST_API_SECRET_ACCESS_KEY S3_TEST_DELIVERY_ACCESS_KEY_ID S3_TEST_DELIVERY_SECRET_ACCESS_KEY S3_TEST_WORKER_ACCESS_KEY_ID S3_TEST_WORKER_SECRET_ACCESS_KEY "
expect_names "test-api: only the restricted test identities" "$(names_test test-api | tr '\n' ' ')" "$TEST_NAMES"
expect_names "test-worker: only the restricted test identities" "$(names_test test-worker | tr '\n' ' ')" "$TEST_NAMES"
if [ -e "$REPO/.git" ]; then
  tracked_ok() { local t; t="$(git -C "$REPO_HOST" ls-files .local)" && [ -z "$t" ] && git -C "$REPO_HOST" check-ignore -q .local/secrets/probe.env; }
  check "no secret file tracked by Git (.local/ ignored)" tracked_ok
fi

printf '\n==> Test suites (ephemeral test containers)\n'
if [ "$FULL" -eq 0 ]; then
  run_suite "storage identities: permission matrix + bucket verification" test-api \
    npx jest --selectProjects integration --testPathPatterns src/storage/storage-permissions src/storage/storage.service.integration
  run_suite "upload, completion, streaming (Range) and download — HTTP" test-api \
    npx jest --config ./test/jest-e2e.json --runInBand --testPathPatterns videos-upload-complete videos-delivery-urls
  run_suite "asynchronous processing: ffprobe metadata + thumbnail (FFmpeg)" test-worker \
    env MEDIA_TOOLS_REQUIRED=1 npx jest --selectProjects integration --testPathPatterns src/worker/video-processing.worker src/media/media-probe
else
  run_suite "unit + integration (npm test)" test-api npm test
  run_suite "e2e (npm run test:e2e)" test-api npm run test:e2e
  run_suite "media and worker suites with FFmpeg (npm run test:media)" test-worker npm run test:media
  run_suite "TypeScript (tsc --noEmit)" test-api npx tsc --noEmit
  run_suite "lint (eslint, check only)" test-api npx eslint "{src,apps,libs,test}/**/*.ts"
fi

printf '\n==> Summary: %s passed, %s failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then echo "RESULT: PASS"; exit 0; fi
echo "RESULT: FAIL"; exit 1
