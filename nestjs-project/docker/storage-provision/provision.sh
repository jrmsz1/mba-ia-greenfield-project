#!/bin/sh
# Idempotent, fail-closed, non-destructive storage provisioning
# (phase-03-videos/TD-03, TD-04, TD-15, TD-16 revisions of 2026-11-12).
#
# Runs ONLY in the ephemeral mc admin container (image built from
# ./Dockerfile; never a Compose service). It is the only place where the
# MinIO root credentials are used. It never deletes, recreates or overwrites a
# bucket, object, user or policy, and never rotates an existing user's secret.
# Secrets are never printed; identities are logged by role only.
#
# Required environment (values come from an env file outside the repo):
#   MINIO_ENDPOINT                     e.g. http://minio:9000
#   MINIO_ROOT_USER, MINIO_ROOT_PASSWORD
#   S3_BUCKET, S3_TEST_BUCKET
#   S3_{API,WORKER,DELIVERY}_{ACCESS_KEY_ID,SECRET_ACCESS_KEY}            (S3_BUCKET)
#   S3_TEST_{API,WORKER,DELIVERY,MAINTENANCE}_{ACCESS_KEY_ID,SECRET_ACCESS_KEY}
#                                                                      (S3_TEST_BUCKET)
# Optional: PROVISION_MODE=check  -> run every preflight, write nothing.
set -eu

POLICY_DIR="${POLICY_DIR:-/provision/policies}"
MODE="${PROVISION_MODE:-apply}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log() { printf '%s\n' "$*"; }
fail() { printf 'FAIL-CLOSED: %s\n' "$*" >&2; exit 1; }

# role | bucket variable | credential prefix | policy template
ROLES='api S3_BUCKET S3_API api
worker S3_BUCKET S3_WORKER worker
delivery S3_BUCKET S3_DELIVERY delivery
test-api S3_TEST_BUCKET S3_TEST_API api
test-worker S3_TEST_BUCKET S3_TEST_WORKER worker
test-delivery S3_TEST_BUCKET S3_TEST_DELIVERY delivery
test-maintenance S3_TEST_BUCKET S3_TEST_MAINTENANCE maintenance'

var() { eval "printf '%s' \"\${$1:-}\""; }
require() { [ -n "$(var "$1")" ] || fail "$1 is required"; }

# --- Phase 0 — static preflight (no network) --------------------------------
for key in MINIO_ENDPOINT MINIO_ROOT_USER MINIO_ROOT_PASSWORD S3_BUCKET S3_TEST_BUCKET; do
  require "$key"
done
case "$MODE" in apply|check) ;; *) fail "PROVISION_MODE must be apply or check" ;; esac

valid_bucket() { printf '%s' "$1" | grep -Eq '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'; }
valid_bucket "$S3_BUCKET" || fail "S3_BUCKET is not a valid bucket name"
valid_bucket "$S3_TEST_BUCKET" || fail "S3_TEST_BUCKET is not a valid bucket name"
printf '%s' "$S3_TEST_BUCKET" | grep -Eq -- '-test$' || fail "S3_TEST_BUCKET must end with -test"
[ "$S3_TEST_BUCKET" != "$S3_BUCKET" ] || fail "S3_TEST_BUCKET must differ from S3_BUCKET"

IDS="$WORK/ids"
: > "$IDS"
printf '%s\n' "$ROLES" | while read -r role bucket_var prefix template; do
  require "${prefix}_ACCESS_KEY_ID"
  require "${prefix}_SECRET_ACCESS_KEY"
  access="$(var "${prefix}_ACCESS_KEY_ID")"
  secret="$(var "${prefix}_SECRET_ACCESS_KEY")"
  [ "${#access}" -ge 3 ] || fail "${prefix}_ACCESS_KEY_ID is too short (MinIO needs >= 3)"
  [ "${#secret}" -ge 8 ] || fail "${prefix}_SECRET_ACCESS_KEY is too short (MinIO needs >= 8)"
  # No operational, test or maintenance identity may be the administrative one.
  [ "$access" != "$MINIO_ROOT_USER" ] || fail "identity ${role} equals the MinIO root user"
  printf '%s\n' "$access" >> "$IDS"
  [ -f "${POLICY_DIR}/${template}.json" ] || fail "missing policy template ${template}.json"
done
[ "$(sort "$IDS" | uniq -d | wc -l)" -eq 0 ] || fail "two identities share the same access key ID"
log "preflight (static): OK — 2 buckets, 7 distinct identities, none equal to root"

# Root credentials enter mc only through this variable, inside the container.
scheme="${MINIO_ENDPOINT%%://*}"
hostport="${MINIO_ENDPOINT#*://}"
export MC_HOST_admin="${scheme}://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@${hostport}"
mc admin info admin >/dev/null 2>&1 || fail "cannot reach MinIO at ${MINIO_ENDPOINT} with the root credentials"

# Policies are content-addressed: streamtube-<role>-<sha256(rendered)[0:8]>.
render() { # role template bucket -> rendered path
  sed "s/__BUCKET__/$3/g" "${POLICY_DIR}/$2.json" > "${WORK}/$1.json"
  printf '%s' "${WORK}/$1.json"
}
policy_name() { printf 'streamtube-%s-%s' "$1" "$(sha256sum "$2" | cut -c1-8)"; }
# MinIO re-serializes a stored policy and returns Action/Resource arrays in no
# fixed order, so documents are compared as sorted "sid<TAB>field<TAB>value"
# lines: same statements, effects, actions and resources, order-insensitive
# inside a statement. (Policy values never contain double quotes.)
canonical() {
  grep -o '"[^"]*"' "$1" | tr -d '"' | awk '
    BEGIN { sid = "-" }
    /^(Version|Statement|Sid|Effect|Action|NotAction|Resource|NotResource|Principal|Condition)$/ { key = $0; next }
    key == "Sid" { sid = $0; next }
    key != "" { print sid "\t" key "\t" $0 }
  ' | sort
}

# --- Phase 1 — remote preflight (read-only) ---------------------------------
# Every existing resource is validated before any write; a conflict stops the
# run here, so it leaves no partial state.
printf '%s\n' "$ROLES" | while read -r role bucket_var prefix template; do
  bucket="$(var "$bucket_var")"
  file="$(render "$role" "$template" "$bucket")"
  name="$(policy_name "$role" "$file")"
  if mc admin policy info admin "$name" --policy-file "${WORK}/${role}.existing" >/dev/null 2>&1; then
    [ "$(canonical "${WORK}/${role}.existing")" = "$(canonical "$file")" ] \
      || fail "policy ${name} exists with different content (no change made)"
  fi
  access="$(var "${prefix}_ACCESS_KEY_ID")"
  if info="$(mc admin user info admin "$access" --json 2>/dev/null)"; then
    flat="$(printf '%s' "$info" | tr -d ' \n')"
    attached="$(printf '%s' "$flat" | sed -n 's/.*"policyName":"\([^"]*\)".*/\1/p')"
    status="$(printf '%s' "$flat" | sed -n 's/.*"userStatus":"\([^"]*\)".*/\1/p')"
    [ "$attached" = "$name" ] \
      || fail "identity ${role} exists with policy '${attached}', expected '${name}' (no change made)"
    [ "$status" = "enabled" ] \
      || fail "identity ${role} exists but is '${status}' (no change made)"
  fi
done
for bucket_var in S3_BUCKET S3_TEST_BUCKET; do
  bucket="$(var "$bucket_var")"
  if ! mc stat "admin/${bucket}" >/dev/null 2>&1; then
    # Absent is fine (it will be created); anything else must be explained.
    mc ls admin 2>/dev/null | grep -q " ${bucket}/\$" \
      && fail "bucket ${bucket} is listed but not readable (no change made)"
  fi
done
log "preflight (remote): OK — no conflicting bucket, policy or identity"

if [ "$MODE" = "check" ]; then
  log "check mode: nothing written"
  exit 0
fi

# --- Phase 2 — apply (creates only what is missing) -------------------------
for bucket_var in S3_BUCKET S3_TEST_BUCKET; do
  bucket="$(var "$bucket_var")"
  if mc stat "admin/${bucket}" >/dev/null 2>&1; then
    log "bucket ${bucket_var}: exists (kept as is)"
  else
    mc mb "admin/${bucket}" >/dev/null || fail "could not create bucket ${bucket_var}"
    log "bucket ${bucket_var}: created"
  fi
done

printf '%s\n' "$ROLES" | while read -r role bucket_var prefix template; do
  file="${WORK}/${role}.json"
  name="$(policy_name "$role" "$file")"
  if mc admin policy info admin "$name" >/dev/null 2>&1; then
    log "policy ${role}: exists (identical, content-addressed)"
  else
    mc admin policy create admin "$name" "$file" >/dev/null || fail "could not create policy for ${role}"
    log "policy ${role}: created"
  fi
  access="$(var "${prefix}_ACCESS_KEY_ID")"
  if mc admin user info admin "$access" >/dev/null 2>&1; then
    log "identity ${role}: exists with its policy (kept; secret not touched)"
  else
    # The secret is an argument of mc inside this ephemeral container only.
    mc admin user add admin "$access" "$(var "${prefix}_SECRET_ACCESS_KEY")" >/dev/null \
      || fail "could not create identity ${role}"
    mc admin policy attach admin "$name" --user "$access" >/dev/null \
      || fail "could not attach the policy of ${role}"
    log "identity ${role}: created"
  fi
done
log "provisioning complete"
