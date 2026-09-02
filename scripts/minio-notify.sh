#!/usr/bin/env bash
# Point SOURCE-bucket notifications at Note Hub file-level sync.
# Does NOT notify the hub canonical/preview bucket (hub-dev).
# Downloads mc if missing. Idempotent. Remote endpoints are skipped by the API.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

MC_BIN="${MC_BIN:-}"
if [ -z "$MC_BIN" ]; then
  if command -v mc >/dev/null 2>&1; then
    MC_BIN="$(command -v mc)"
  else
    MC_BIN="/tmp/notehub-mc"
    if [ ! -x "$MC_BIN" ]; then
      echo "minio-notify: downloading mc"
      if ! curl -fsSL "https://dl.min.io/client/mc/release/linux-amd64/mc" -o "$MC_BIN"; then
        echo "minio-notify: mc download failed, skip"
        exit 0
      fi
      chmod +x "$MC_BIN"
    fi
  fi
fi

ALIAS="${MINIO_MC_ALIAS:-notehub}"
ENDPOINT="${S3_ENDPOINT:-http://127.0.0.1:9000}"
ACCESS="${S3_ACCESS_KEY:-minioadmin}"
SECRET="${S3_SECRET_KEY:-minioadmin}"
HOOK="${HOOK_URL:-http://127.0.0.1:3001/v1/hooks/s3}"
TOKEN="${HUB_SECRET:-dev-hub-secret-change-me}"
VAULT="${VAULT_BUCKET:-obsidian-src}"
# Source buckets only. Never the hub canonical bucket.
if [ -n "${SOURCE_BUCKETS:-}" ]; then
  IFS=',' read -r -a BUCKETS <<< "$SOURCE_BUCKETS"
else
  BUCKETS=("$VAULT" "siyuan-src")
fi

"$MC_BIN" alias set "$ALIAS" "$ENDPOINT" "$ACCESS" "$SECRET" >/dev/null 2>&1 || true

# Register webhook target. Restart is required on some MinIO builds; try without first.
CFG_OK=0
if "$MC_BIN" admin config set "$ALIAS" notify_webhook:notehub \
    "endpoint=$HOOK" "auth_token=$TOKEN" >/dev/null 2>&1; then
  CFG_OK=1
fi

# Do not restart MinIO by default (OCR drain may be reading hub-dev).
if [ "${MINIO_NOTIFY_RESTART:-0}" = "1" ] && [ "$CFG_OK" = "1" ]; then
  "$MC_BIN" admin service restart "$ALIAS" >/dev/null 2>&1 || true
  sleep 2
fi

for b in "${BUCKETS[@]}"; do
  b="$(echo "$b" | tr -d '[:space:]')"
  [ -z "$b" ] && continue
  if [ "$b" = "${S3_BUCKET:-hub-dev}" ]; then
    echo "minio-notify: skip hub bucket $b"
    continue
  fi
  if "$MC_BIN" event add "$ALIAS/$b" arn:minio:sqs::_:notehub --event put,delete >/dev/null 2>&1; then
    echo "minio-notify: event add ok $b"
  else
    echo "minio-notify: event add skipped for $b (webhook target may need MinIO restart)"
  fi
done

echo "minio-notify: source buckets should POST to $HOOK"
exit 0
