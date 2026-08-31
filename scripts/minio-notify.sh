#!/usr/bin/env bash
# Point MinIO bucket notifications at Note Hub file-level sync.
# Optional: exits 0 if `mc` is not installed.
set -u
if ! command -v mc >/dev/null 2>&1; then
  echo "minio-notify: mc not found, skip"
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

ALIAS="${MINIO_MC_ALIAS:-notehub}"
ENDPOINT="${S3_ENDPOINT:-http://127.0.0.1:9000}"
ACCESS="${S3_ACCESS_KEY:-minioadmin}"
SECRET="${S3_SECRET_KEY:-minioadmin}"
HOOK="${HOOK_URL:-http://127.0.0.1:3001/v1/hooks/s3}"
TOKEN="${HUB_SECRET:-dev-hub-secret-change-me}"
VAULT="${VAULT_BUCKET:-obsidian-src}"
HUB="${S3_BUCKET:-hub-dev}"

mc alias set "$ALIAS" "$ENDPOINT" "$ACCESS" "$SECRET" >/dev/null 2>&1 || true
mc admin config set "$ALIAS" notify_webhook:notehub "endpoint=$HOOK" "auth_token=$TOKEN" >/dev/null 2>&1 || true
mc admin service restart "$ALIAS" >/dev/null 2>&1 || true

for b in "$VAULT" siyuan-src "$HUB"; do
  if ! mc event add "$ALIAS/$b" arn:minio:sqs::_:notehub --event put,delete >/dev/null 2>&1; then
    echo "minio-notify: event add skipped for $b"
  fi
done

echo "minio-notify: buckets should POST to $HOOK"
exit 0
