#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$PATH"
API="${API_URL:-http://127.0.0.1:3001}"
export DATABASE_URL="${DATABASE_URL:-postgres://notehub:notehub@127.0.0.1:5432/notehub}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export S3_ENDPOINT="${S3_ENDPOINT:-http://127.0.0.1:9000}"
export S3_REGION="${S3_REGION:-us-east-1}"
export S3_BUCKET="${S3_BUCKET:-hub-dev}"
export S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
export S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"
export HUB_SECRET="${HUB_SECRET:-dev-hub-secret-change-me}"
export VAULT_BUCKET="${VAULT_BUCKET:-obsidian-src}"

PM_BIN="$(command -v pnpm || true)"
if [ -z "$PM_BIN" ]; then
  PM_BIN="node $HOME/.local/lib/node_modules/pnpm/bin/pnpm.cjs"
fi

echo "== seed fixture =="
$PM_BIN --filter @note-hub/api seed

EMAIL="p0-$(date +%s)@example.com"
PASS="secret12"
echo "== register $EMAIL =="
REG=$(curl -sf -X POST "$API/v1/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"display_name\":\"P0 Bot\"}")
TOKEN=$(echo "$REG" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).token))")
SPACE=$(echo "$REG" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).space.id))")
AUTH="Authorization: Bearer $TOKEN"

echo "== create connection =="
CONN=$(curl -sf -X POST "$API/v1/spaces/$SPACE/connections" -H 'content-type: application/json' -H "$AUTH" \
  -d "{\"source\":\"obsidian\",\"name\":\"fixture vault\",\"config\":{\"bucket\":\"obsidian-src\",\"region\":\"us-east-1\",\"remote_prefix\":\"vault1\",\"endpoint\":\"http://127.0.0.1:9000\",\"ignore\":[\".obsidian/\",\".trash/\"],\"e2ee\":false},\"secrets\":{\"access_key\":\"minioadmin\",\"secret_key\":\"minioadmin\"}}")
# secrets must not leak
echo "$CONN" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); if(JSON.stringify(j).includes('minioadmin') && JSON.stringify(j).includes('secret_key')) {console.error('secrets leaked'); process.exit(1);} console.log(j.connection.id)})" > /tmp/conn_id
CID=$(cat /tmp/conn_id)
echo "connection $CID"

echo "== probe + sync =="
curl -sf -X POST "$API/v1/connections/$CID/probe" -H "$AUTH" >/dev/null
curl -sf -X POST "$API/v1/connections/$CID/sync" -H "$AUTH" >/dev/null

echo "== wait for sync =="
ok=0
for i in $(seq 1 30); do
  ST=$(curl -sf "$API/v1/connections/$CID/sync" -H "$AUTH")
  FIN=$(echo "$ST" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); const r=(j.runs||[])[0]; console.log(r && r.finished_at ? 'yes':'no')})")
  if [ "$FIN" = "yes" ]; then ok=1; break; fi
  sleep 1
done
if [ "$ok" != 1 ]; then echo "sync did not finish"; exit 1; fi

echo "== notes =="
NOTES=$(curl -sf "$API/v1/spaces/$SPACE/notes" -H "$AUTH")
echo "$NOTES" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); const paths=j.notes.map(n=>n.path).sort(); console.log(paths.join(',')); if(paths.some(p=>p.includes('.obsidian')||p.includes('.trash')||p.includes('deleted.md'))) {process.exit(2)} const hasW=paths.includes('Welcome.md'); const hasD=paths.includes('Daily/2026-08-29.md'); if(!hasW||!hasD) process.exit(3);})"

WID=$(echo "$NOTES" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); console.log(j.notes.find(n=>n.path==='Welcome.md').id)})")
echo "== preview Welcome =="
PREV=$(curl -sf "$API/v1/notes/$WID/preview" -H "$AUTH")
echo "$PREV" | grep -q "欢迎来到笔记中枢夹具库"
echo "$PREV" | grep -q 'id="b-'

echo "== search daily phrase =="
SR=$(curl -sf "$API/v1/spaces/$SPACE/search?q=$(printf %s '紫铜灯笼检索词' | jq -sRr @uri)" -H "$AUTH")
echo "$SR" | grep -q "2026-08-29"
SR2=$(curl -sf "$API/v1/spaces/$SPACE/search?q=PINEAPPLE_LANTERN_ZHONGSHU" -H "$AUTH")
echo "$SR2" | grep -q "PINEAPPLE_LANTERN_ZHONGSHU\|2026-08-29\|Daily"

echo "P0 acceptance OK"
