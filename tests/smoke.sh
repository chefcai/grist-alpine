#!/usr/bin/env bash
# Smoke test for a grist-alpine image.
#   - server boots and answers /status
#   - gVisor sandbox check passes
#   - a document can be created and a Python formula column computes
# Usage: tests/smoke.sh <image> [host-port]
# Set DOCKER=podman to use podman instead of docker.
set -euo pipefail

IMAGE="${1:?usage: smoke.sh <image> [host-port]}"
PORT="${2:-18484}"
DOCKER="${DOCKER:-docker}"
NAME="grist-smoke-$$"
USER_HEADER="X-Smoke-User"
EMAIL="smoke@example.com"
BASE="http://127.0.0.1:${PORT}"

cleanup() {
  echo "--- container logs (tail) ---"
  "$DOCKER" logs --tail 40 "$NAME" 2>&1 || true
  "$DOCKER" rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"$DOCKER" run -d --name "$NAME" -p "127.0.0.1:${PORT}:8484" \
  -e GRIST_FORWARD_AUTH_HEADER="$USER_HEADER" \
  -e GRIST_IGNORE_SESSION=true \
  -e GRIST_DEFAULT_EMAIL="$EMAIL" \
  -e GRIST_SINGLE_ORG=docs \
  -e GRIST_SANDBOX_FLAVOR=gvisor \
  "$IMAGE" >/dev/null

echo "Waiting for Grist to answer /status ..."
for i in $(seq 1 90); do
  if curl -fsS "$BASE/status" >/dev/null 2>&1; then echo "up after ${i}s"; break; fi
  sleep 1
  if [ "$i" = 90 ]; then echo "FAIL: server did not come up"; exit 1; fi
done

api() { curl -fsS -H "$USER_HEADER: $EMAIL" -H 'Content-Type: application/json' "$@"; }

WS=$(api "$BASE/api/orgs/current/workspaces" | jq -r '.[0].id')
[ -n "$WS" ] && [ "$WS" != "null" ] || { echo "FAIL: no workspace"; exit 1; }
echo "workspace: $WS"

DOC=$(api -X POST "$BASE/api/workspaces/$WS/docs" -d '{"name":"smoke"}' | tr -d '"')
[ -n "$DOC" ] || { echo "FAIL: doc not created"; exit 1; }
echo "doc: $DOC"

api -X POST "$BASE/api/docs/$DOC/tables" -d '{"tables":[{"id":"T","columns":[
  {"id":"A","fields":{"type":"Numeric"}},
  {"id":"B","fields":{"type":"Numeric","isFormula":true,"formula":"$A * 2"}},
  {"id":"C","fields":{"type":"Text","isFormula":true,"formula":"import sys; \"%d.%d\" % sys.version_info[:2]"}}
]}]}' >/dev/null

api -X POST "$BASE/api/docs/$DOC/tables/T/records" -d '{"records":[{"fields":{"A":21}}]}' >/dev/null
ROW=$(api "$BASE/api/docs/$DOC/tables/T/records" | jq -c '.records[0].fields')
echo "row: $ROW"

B=$(echo "$ROW" | jq -r '.B')
[ "$B" = "42" ] || { echo "FAIL: formula B expected 42, got $B"; exit 1; }

# Web UI: every script/stylesheet referenced by the app pages must load.
for page in "/" "/doc/$DOC" "/apiconsole"; do
  HTML=$(curl -fsSL -H "$USER_HEADER: $EMAIL" "$BASE$page") || { echo "FAIL: page $page"; exit 1; }
  # Relative asset paths resolve against <base href> like a browser would.
  BASEHREF=$( (echo "$HTML" | grep -oiE '<base href="[^"]*"' || true) | head -1 | sed -E 's/.*href="//; s/"$//')
  BASEHREF=$(echo "$BASEHREF" | sed -E 's#^https?://[^/]+##')
  case "$BASEHREF" in "") BASEHREF="${page%/*}/" ;; esac
  ASSETS=$( (echo "$HTML" | grep -oE '(src|href)="[^"]+\.(js|css)"' || true) | sed -E 's/^(src|href)="//; s/"$//' | sort -u)
  [ -n "$ASSETS" ] || { echo "FAIL: no assets found on $page"; exit 1; }
  n=0
  for a in $ASSETS; do
    case "$a" in
      //*) continue ;;                                   # protocol-relative third-party
      http*://*) url=$(echo "$a" | sed -E "s#^https?://[^/]+#${BASE}#") ;;
      /*) url="$BASE$a" ;;
      *) url="$BASE${BASEHREF%/}/${a#./}" ;;
    esac
    code=$(curl -s -o /dev/null -w '%{http_code}' "$url")
    [ "$code" = 200 ] || { echo "FAIL: $page asset $a -> HTTP $code"; exit 1; }
    n=$((n+1))
  done
  [ "$n" -gt 0 ] || { echo "FAIL: no same-origin assets checked on $page"; exit 1; }
  echo "page $page: $n assets OK"
done

# Capture first: grep -q exits early and pipefail would report SIGPIPE as failure.
LOGS=$("$DOCKER" logs "$NAME" 2>&1 || true)
if ! grep -q "gvisor check ok" <<<"$LOGS"; then
  echo "FAIL: gVisor sandbox check did not pass"; exit 1
fi

echo "PASS: Grist up, gVisor ok, formula engine ok (python $(echo "$ROW" | jq -r '.C'))"
