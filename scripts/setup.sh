#!/usr/bin/env bash
# StreamTube — one-command local setup (Linux/macOS; also Git Bash on Windows).
#
#   ./scripts/setup.sh                 prepare everything and start the stack
#   ./scripts/setup.sh --prepare-only  only generate/validate the credential
#                                      files (no container is started or
#                                      changed; a running MinIO gets a
#                                      read-only provisioning preflight)
#
# Safe to re-run: existing credentials are never overwritten, provisioning is
# idempotent and non-destructive, migrations only apply what is pending.
# Secrets are generated into <repo>/.local/secrets/ (git-ignored, outside every
# bind mount) and are never printed. See phase-03-videos/TD-15 and TD-16.
set -euo pipefail

MODE="full"
case "${1:-}" in
  "") ;;
  --prepare-only) MODE="prepare" ;;
  -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
  *) echo "Unknown option: $1 (use --prepare-only or --help)" >&2; exit 2 ;;
esac

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$REPO/nestjs-project"
SECRETS="$REPO/.local/secrets"
ENV_FILE="$BACKEND/.env"
PROVISION_IMAGE="streamtube-storage-provision:local"
# Git Bash on Windows: keep container paths (/provision, …) unconverted, and
# hand Docker and git (native Windows programs there) Windows-form host paths.
export MSYS_NO_PATHCONV=1
host_path() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
REPO_HOST="$(host_path "$REPO")"
BACKEND_HOST="$(host_path "$BACKEND")"
SECRETS_HOST=""  # set once the directory exists

step() { printf '\n==> %s\n' "$*"; }
ok() { printf '    OK   %s\n' "$*"; }
warn() { printf '    WARN %s\n' "$*"; }
die() { printf '    FAIL %s\n' "$*" >&2; exit 1; }
compose() { docker compose --project-directory "$BACKEND_HOST" -f "$BACKEND_HOST/compose.yaml" "$@"; }
rand_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
# Value of KEY in FILE (never printed by this script).
get() { sed -n "s/^$1=//p" "$2" | head -n 1 | tr -d '\r'; }

CREDENTIAL_KEYS_RE='^(MINIO_ROOT_USER|MINIO_ROOT_PASSWORD|S3_ACCESS_KEY_ID|S3_SECRET_ACCESS_KEY|S3_DELIVERY_ACCESS_KEY_ID|S3_DELIVERY_SECRET_ACCESS_KEY|S3_API_[A-Z_]+|S3_WORKER_[A-Z_]+|S3_TEST_(API|WORKER|DELIVERY|MAINTENANCE)_[A-Z_]+)='

# ---------------------------------------------------------------- 1. prerequisites
step "Checking prerequisites"
command -v docker >/dev/null 2>&1 || die "docker not found — install Docker Desktop or Docker Engine"
docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable — start Docker and retry"
COMPOSE_VERSION="$(docker compose version --short 2>/dev/null | sed 's/^v//')" || die "docker compose (v2) not found"
IFS=. read -r CV_MAJOR CV_MINOR _ <<<"$COMPOSE_VERSION"
if [ "${CV_MAJOR:-0}" -lt 2 ] || { [ "${CV_MAJOR:-0}" -eq 2 ] && [ "${CV_MINOR:-0}" -lt 24 ]; }; then
  die "docker compose $COMPOSE_VERSION is too old (2.24+ is required for env_file with 'required')"
fi
ok "docker and docker compose $COMPOSE_VERSION"
AVAIL_KB="$(df -Pk "$REPO" | awk 'NR==2 {print $4}')"
if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt 10485760 ]; then
  warn "less than 10 GiB free on this disk; the stack runs, but the optional 10 GiB verification needs ~30 GiB"
else
  ok "free disk space"
fi
# Inside a git checkout the check is mandatory: it never silently skips.
if [ -e "$REPO/.git" ]; then
  command -v git >/dev/null 2>&1 || die "this is a git checkout but git is not installed — cannot confirm .local/ is ignored"
  git -C "$REPO_HOST" check-ignore -q ".local/secrets/probe.env" \
    || die ".local/ is not git-ignored (or git failed) — refusing to generate secrets inside the checkout"
  tracked="$(git -C "$REPO_HOST" ls-files .local)" || die "git ls-files failed — cannot confirm no secret is tracked"
  [ -z "$tracked" ] || die "files under .local/ are tracked by Git — remove them from the index first"
  ok ".local/ is git-ignored and untracked"
fi

# ---------------------------------------------------------------- 2. .env (non-secret settings)
step "Preparing nestjs-project/.env (non-secret settings)"
if [ ! -f "$ENV_FILE" ]; then
  awk -v jwt="$(rand_hex 32)" -v refresh="$(rand_hex 32)" -v minio_port="${STREAMTUBE_MINIO_PORT:-9000}" '
    /^JWT_SECRET=/ { print "JWT_SECRET=" jwt; next }
    /^JWT_REFRESH_SECRET=/ { print "JWT_REFRESH_SECRET=" refresh; next }
    /^S3_PUBLIC_ENDPOINT=/ { print "S3_PUBLIC_ENDPOINT=http://localhost:" minio_port; next }
    { print }' "$BACKEND/.env.example" > "$ENV_FILE"
  ok "created from .env.example (random JWT secrets)"
else
  ok "kept the existing .env"
fi
LEGACY_KEYS="$(grep -E "${CREDENTIAL_KEYS_RE}.+" "$ENV_FILE" | cut -d= -f1 | tr '\n' ' ' || true)"

# ---------------------------------------------------------------- 3. credential files
step "Preparing the credential files in .local/secrets/"
umask 077
mkdir -p "$SECRETS"
chmod 700 "$SECRETS" 2>/dev/null || true
SECRETS_HOST="$(host_path "$SECRETS")"

if [ ! -f "$SECRETS/minio.env" ]; then
  legacy_user="$(get MINIO_ROOT_USER "$ENV_FILE")"
  legacy_pass="$(get MINIO_ROOT_PASSWORD "$ENV_FILE")"
  if [ -n "$legacy_user" ] && [ -n "$legacy_pass" ]; then
    printf 'MINIO_ROOT_USER=%s\nMINIO_ROOT_PASSWORD=%s\n' "$legacy_user" "$legacy_pass" > "$SECRETS/minio.env"
    ok "minio.env: reused the existing MinIO root pair from .env (the data volume stays usable)"
  else
    printf 'MINIO_ROOT_USER=%s\nMINIO_ROOT_PASSWORD=%s\n' "streamtube-root-$(rand_hex 3)" "$(rand_hex 24)" > "$SECRETS/minio.env"
    ok "minio.env: generated a new MinIO root pair"
  fi
else
  ok "minio.env: kept (never overwritten)"
fi
ROOT_USER="$(get MINIO_ROOT_USER "$SECRETS/minio.env")"
ROOT_PASS="$(get MINIO_ROOT_PASSWORD "$SECRETS/minio.env")"
[ -n "$ROOT_USER" ] && [ -n "$ROOT_PASS" ] || die "minio.env is incomplete (fix or remove it explicitly; it is never overwritten)"

PREFIXES="S3_API S3_WORKER S3_DELIVERY S3_TEST_API S3_TEST_WORKER S3_TEST_DELIVERY S3_TEST_MAINTENANCE"
if [ ! -f "$SECRETS/provision.env" ]; then
  {
    printf 'MINIO_ROOT_USER=%s\nMINIO_ROOT_PASSWORD=%s\n' "$ROOT_USER" "$ROOT_PASS"
    for p in $PREFIXES; do
      role="$(printf '%s' "${p#S3_}" | tr 'A-Z_' 'a-z-')"
      printf '%s_ACCESS_KEY_ID=%s\n%s_SECRET_ACCESS_KEY=%s\n' "$p" "streamtube-${role}-$(rand_hex 3)" "$p" "$(rand_hex 24)"
    done
  } > "$SECRETS/provision.env"
  ok "provision.env: generated 7 identities"
else
  ok "provision.env: kept (never overwritten)"
fi
for p in $PREFIXES; do
  [ -n "$(get "${p}_ACCESS_KEY_ID" "$SECRETS/provision.env")" ] && [ -n "$(get "${p}_SECRET_ACCESS_KEY" "$SECRETS/provision.env")" ] \
    || die "provision.env misses ${p}_ACCESS_KEY_ID/${p}_SECRET_ACCESS_KEY (fix it explicitly; it is never overwritten)"
done
[ "$(get MINIO_ROOT_USER "$SECRETS/provision.env")" = "$ROOT_USER" ] && [ "$(get MINIO_ROOT_PASSWORD "$SECRETS/provision.env")" = "$ROOT_PASS" ] \
  || die "provision.env and minio.env disagree on the root pair (nothing overwritten)"

# Every per-process file is derived from provision.env (the single source).
pair() { printf '%s=%s\n%s=%s\n' "$1" "$(get "$3_ACCESS_KEY_ID" "$SECRETS/provision.env")" "$2" "$(get "$3_SECRET_ACCESS_KEY" "$SECRETS/provision.env")"; }
expected() {
  case "$1" in
    api.env) pair S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_API; pair S3_DELIVERY_ACCESS_KEY_ID S3_DELIVERY_SECRET_ACCESS_KEY S3_DELIVERY ;;
    worker.env) pair S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_WORKER ;;
    test-api.env|test-worker.env)
      for p in S3_TEST_API S3_TEST_WORKER S3_TEST_DELIVERY; do pair "${p}_ACCESS_KEY_ID" "${p}_SECRET_ACCESS_KEY" "$p"; done ;;
    maintenance.env) pair S3_TEST_MAINTENANCE_ACCESS_KEY_ID S3_TEST_MAINTENANCE_SECRET_ACCESS_KEY S3_TEST_MAINTENANCE ;;
  esac
}
for f in api.env worker.env test-api.env test-worker.env maintenance.env; do
  if [ ! -f "$SECRETS/$f" ]; then
    expected "$f" > "$SECRETS/$f"
    ok "$f: generated"
  elif expected "$f" | cmp -s - <(tr -d '\r' < "$SECRETS/$f"); then
    ok "$f: kept (consistent with provision.env)"
  else
    die "$f differs from provision.env — not overwritten; reconcile it explicitly"
  fi
done
chmod 600 "$SECRETS"/*.env 2>/dev/null || true
# Git Bash on Windows: chmod does not change NTFS ACLs — restrict them too.
if pwd -W >/dev/null 2>&1 && command -v icacls >/dev/null 2>&1; then
  icacls "$SECRETS_HOST" /inheritance:r /grant:r "${USERNAME}:(OI)(CI)F" >/dev/null || die "could not restrict the ACL of .local/secrets"
  for f in "$SECRETS"/*; do
    icacls "$(host_path "$(dirname "$f")")/$(basename "$f")" /inheritance:r /grant:r "${USERNAME}:F" >/dev/null       || die "could not restrict the ACL of $(basename "$f")"
  done
fi
ok "permissions: owner-only"

# ---------------------------------------------------------------- 4. legacy credentials in .env
if [ -n "$LEGACY_KEYS" ]; then
  if [ "$MODE" = "prepare" ]; then
    warn "nestjs-project/.env still holds credentials ($LEGACY_KEYS); the full setup moves them out (prepare-only changes nothing)"
  else
    backup="$SECRETS/legacy-env-$(date +%Y%m%d%H%M%S).bak"
    grep -E "${CREDENTIAL_KEYS_RE}" "$ENV_FILE" > "$backup"
    chmod 600 "$backup" 2>/dev/null || true
    awk -v re="$CREDENTIAL_KEYS_RE" '$0 ~ re { split($0, kv, "="); print "# " kv[1] "= (moved to .local/secrets by setup)"; next } { print }' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
    ok "moved credentials out of .env ($LEGACY_KEYS); backup kept in .local/secrets/ (owner-only)"
  fi
else
  ok "nestjs-project/.env holds no credential"
fi

# ---------------------------------------------------------------- 5. configuration check
step "Validating the Compose configuration (values are never printed)"
compose config --quiet || die "compose.yaml is not valid"
compose -f "$BACKEND_HOST/compose.test.yaml" config --quiet || die "compose.test.yaml is not valid"
ok "compose.yaml + compose.test.yaml"

provision() { # $1 = apply|check
  local minio_id
  minio_id="$(compose ps -q minio)"
  [ -n "$minio_id" ] || die "MinIO is not running"
  docker build -q -t "$PROVISION_IMAGE" "$BACKEND_HOST/docker/storage-provision" >/dev/null || die "could not build the provisioning image"
  docker run --rm --network "container:$minio_id" \
    --env-file "$SECRETS_HOST/provision.env" \
    -e MINIO_ENDPOINT=http://localhost:9000 \
    -e S3_BUCKET="$(get S3_BUCKET "$ENV_FILE")" \
    -e S3_TEST_BUCKET="$(get S3_TEST_BUCKET "$ENV_FILE")" \
    -e PROVISION_MODE="$1" \
    -v "$BACKEND_HOST/docker/storage-provision:/provision:ro" \
    "$PROVISION_IMAGE" /provision/provision.sh | sed 's/^/    /'
}

if [ "$MODE" = "prepare" ]; then
  step "Read-only provisioning preflight"
  if [ -n "$(compose ps -q minio 2>/dev/null)" ]; then
    provision check || die "provisioning preflight refused (nothing was written)"
  else
    warn "MinIO is not running — preflight skipped"
  fi
  printf '\nPrepare-only finished: nothing was started, stopped or changed.\n'
  exit 0
fi

# ---------------------------------------------------------------- 6. infrastructure
step "Starting PostgreSQL, Mailpit and MinIO"
compose up -d --wait db mailpit minio
ok "infrastructure healthy"

if [ -z "$(get DB_TEST_SERVER_ID "$ENV_FILE")" ]; then
  server_id="$(compose exec -T db psql -U streamtube -d postgres -tAc "SELECT system_identifier FROM pg_control_system()" | tr -d '\r[:space:]')"
  [ -n "$server_id" ] || die "could not read the PostgreSQL system identifier"
  awk -v id="$server_id" '/^DB_TEST_SERVER_ID=/ { print "DB_TEST_SERVER_ID=" id; next } { print }' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  ok "DB_TEST_SERVER_ID recorded in .env (machine-specific, git-ignored)"
fi

# ---------------------------------------------------------------- 7. provisioning
step "Provisioning MinIO (buckets, policies, identities — idempotent, non-destructive)"
provision apply || die "provisioning stopped (it never deletes or overwrites anything)"

# ---------------------------------------------------------------- 8. dependencies, build, migrations
step "Installing dependencies, building and applying migrations"
if [ ! -d "$BACKEND/node_modules" ]; then
  compose run --rm --no-deps nestjs-api npm ci
fi
compose run --rm --no-deps nestjs-api npm run build >/dev/null
ok "build"
compose run --rm --no-deps nestjs-api npm run migration:run | tail -n 3 | sed 's/^/    /'
ok "migrations applied (pending ones only)"

# ---------------------------------------------------------------- 9. API and worker
step "Starting the API and the worker"
# Started one after the other, with one bounded, visible retry each: on Docker
# Desktop for Windows a bind-mounted node_modules can briefly return EIO or a
# missing file to a container that starts while another one is loading it.
start_service() {
  if ! compose up -d --wait --force-recreate "$1"; then
    warn "$1 did not start on the first attempt (bind-mount I/O); retrying once in 10 s"
    sleep 10
    if ! compose up -d --wait "$1"; then
      compose logs --tail 30 "$1" | sed 's/^/    /'
      die "$1 did not start"
    fi
  fi
}
start_service nestjs-api
start_service worker
compose exec -T nestjs-api curl -fsS http://localhost:3000/ >/dev/null || die "the API does not answer"
ok "API answering on http://localhost:${STREAMTUBE_API_PORT:-3000}"
worker_ready() { case "$(compose logs worker 2>/dev/null || true)" in *'Video worker started'*) return 0 ;; *) return 1 ;; esac; }
for _ in $(seq 1 30); do worker_ready && break; sleep 2; done
worker_ready || die "the worker did not report 'Video worker started'"
ok "worker connected to the queue"

cat <<EOF

StreamTube is running.
  API ............ http://localhost:${STREAMTUBE_API_PORT:-3000}   (OpenAPI: set SWAGGER_ENABLED=true in nestjs-project/.env)
  MinIO console .. http://localhost:${STREAMTUBE_MINIO_CONSOLE_PORT:-9001}
  Mailpit ........ http://localhost:${STREAMTUBE_MAILPIT_UI_PORT:-8025}
Next:
  ./scripts/verify.sh          quick verification (health, isolation, essential tests)
  ./scripts/verify.sh --full   full regression (unit, integration, e2e, media, tsc, lint)
Credentials live in .local/secrets/ (never printed, never versioned).
EOF
