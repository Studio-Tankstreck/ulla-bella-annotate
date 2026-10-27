#!/usr/bin/env bash
# Ulla-Bella Task 09B — YOOtheme MCP editing loop E2E. Runs ON ub-host,
# next to Hermes. The adapter drives Hermes (127.0.0.1:8642) to edit the Joomla
# site through the YOOtheme MCP, reached via the reverse SSH tunnel
# 127.0.0.1:18780 -> dev-host:32772. Hermes stays local (never exposed).
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/lib.sh

RELAY_ADDR="${RELAY_ADDR:-127.0.0.1:8787}"
BASE="http://$RELAY_ADDR"
SITE_ID="site_ub_joomla"
HERMES_BASE="${HERMES_BASE:-http://127.0.0.1:8642}"
TUNNEL_ENDPOINT="${YTB_MCP_ENDPOINT:-http://127.0.0.1:18780/api/index.php/v1/yt-builder-mcp}"

DB="$(new_db)"
export RELAY_DB_FILE="$DB"
ADAPTER_LOG="$(mktemp)"
JOB_FILE="$(mktemp)"

# Read the MCP token from the agent-side env file (git-ignored, never echoed).
MCP_ENV_FILE="${MCP_ENV_FILE:-.mcp-dev.env}"
if [[ ! -f "$MCP_ENV_FILE" ]]; then
  echo "ERROR: missing $MCP_ENV_FILE (agent-side MCP token)" >&2
  exit 1
fi
# shellcheck disable=SC1091
source "$MCP_ENV_FILE"   # sets YTB_MCP_TOKEN (and a local-only YTB_MCP_ENDPOINT)
export YTB_MCP_TOKEN
export YTB_MCP_ENDPOINT="$TUNNEL_ENDPOINT"

# Read the Hermes API key from the local Hermes env (never echoed).
HERMES_API_KEY="$(grep -E '^API_SERVER_KEY=' "$HOME/.hermes/.env" | head -n1 | cut -d= -f2- | tr -d '\r\n"')"
if [[ -z "$HERMES_API_KEY" ]]; then
  echo "ERROR: could not read API_SERVER_KEY from ~/.hermes/.env" >&2
  exit 1
fi
export HERMES_API_KEY

cleanup() {
  trap - EXIT
  [[ -n "${RELAY_PID:-}" ]] && kill "$RELAY_PID" 2>/dev/null || true
  [[ -n "${ADAPTER_PID:-}" ]] && kill "$ADAPTER_PID" 2>/dev/null || true
  rm -rf "$(dirname "$DB")" "$ADAPTER_LOG" "$JOB_FILE"
}
trap cleanup EXIT

echo "==> build"
build_bins

echo "==> seed Site + Agent"
seed_site "$SITE_ID" "https://joomla.example.test" "Ulla-Bella Joomla"
AGENT_CRED="$(create_agent agent_demo "Demo Agent")"
grant_site agent_demo "$SITE_ID"

echo "==> starting relay on $RELAY_ADDR"
RELAY_ADDR="$RELAY_ADDR" SCHEMA_DIR="protocol" RELAY_DB_FILE="$DB" ./bin/relay &
RELAY_PID=$!
wait_relay "$BASE"

echo "==> starting Hermes adapter (yootheme-mcp site)"
RELAY_ADDR="$RELAY_ADDR" ADAPTER_AGENT_ID=agent_demo ADAPTER_AGENT_CREDENTIAL="$AGENT_CRED" \
  ADAPTER_MODE=hermes \
  HERMES_BASE_URL="$HERMES_BASE" HERMES_MODEL="hermes-agent" \
  YTB_MCP_ENDPOINT="$YTB_MCP_ENDPOINT" YTB_MCP_TOKEN="$YTB_MCP_TOKEN" \
  ./bin/adapter >"$ADAPTER_LOG" 2>&1 &
ADAPTER_PID=$!
wait_adapter "$ADAPTER_LOG"

echo "==> pair Device"
read -r DEVICE_ID CRED < <(pair_device "$BASE" "$SITE_ID")

echo "==> running client (Hermes edit + verify can take a while)"
regen_fixture protocol/fixtures/joomla-job.json "$DEVICE_ID" "$SITE_ID" >"$JOB_FILE"
RELAY_ADDR="$RELAY_ADDR" CLIENT_TIMEOUT=240 DEVICE_CREDENTIAL="$CRED" JOB_FIXTURE="$JOB_FILE" ./bin/client

echo "==> reading back heading via MCP (through tunnel)"
curl -fsS -X POST "$YTB_MCP_ENDPOINT/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $YTB_MCP_TOKEN" \
  -H "X-Ytb-Mcp-Client: 2.3.1" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"yootheme_builder_element_get","arguments":{"layout_id":"article:1","element_path":"/children/0/children/0/children/0/children/0"}}}' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("heading content:", d["result"]["structuredContent"]["props"]["content"])'
