#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$PATH"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
export DATABASE_URL="${DATABASE_URL:-postgres://notehub:notehub@127.0.0.1:5432/notehub}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export S3_ENDPOINT="${S3_ENDPOINT:-http://127.0.0.1:9000}"
export S3_REGION="${S3_REGION:-us-east-1}"
export S3_BUCKET="${S3_BUCKET:-hub-dev}"
export S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
export S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"
export HUB_SECRET="${HUB_SECRET:-dev-hub-secret-change-me}"
export VAULT_BUCKET="${VAULT_BUCKET:-obsidian-src}"
export API_PORT="${API_PORT:-3001}"
export WEB_ORIGIN="${WEB_ORIGIN:-http://127.0.0.1:3000}"
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://127.0.0.1:3001}"

if command -v docker >/dev/null 2>&1; then
  echo "docker compose up -d"
  docker compose up -d
else
  echo "no docker; using local postgres/redis/minio"
  pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 || sudo pg_ctlcluster 17 main start || true
  redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes --bind 127.0.0.1
  if ! curl -sf -o /dev/null "$S3_ENDPOINT/minio/health/live"; then
    echo "start minio on :9000 first"
    exit 1
  fi
fi

PM_BIN="$(command -v pnpm || true)"
if [ -z "$PM_BIN" ]; then
  PM_BIN="$(command -v node) $HOME/.local/lib/node_modules/pnpm/bin/pnpm.cjs"
fi
$PM_BIN install
$PM_BIN --filter @note-hub/api migrate
$PM_BIN --filter @note-hub/api seed
echo "boot ready. run:"
echo "  $PM_BIN --filter @note-hub/api dev"
echo "  $PM_BIN --filter @note-hub/worker dev"
echo "  $PM_BIN --filter @note-hub/web dev"
