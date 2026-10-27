#!/usr/bin/env bash
# Ulla-Bella Task 07 — real-Hermes E2E. Runs ON ub-host, next to Hermes.
# Topology deviation (documented): Relay runs as a separate process on the VM;
# the adapter still initiates the outbound WS connection to it. Hermes stays
# local (127.0.0.1:8642), never exposed to the LAN.
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/lib.sh

RELAY_ADDR="${RELAY_ADDR:-127.0.0.1:8787}"
BASE="http://$RELAY_ADDR"
SITE_ID="site_01j7x9k2m"
WORKSPACE="${WORKSPACE:-/srv/ulla-bella-sites/example.test}"
HERMES_BASE="${HERMES_BASE:-http://127.0.0.1:8642}"

DB="$(new_db)"
export RELAY_DB_FILE="$DB"
ADAPTER_LOG="$(mktemp)"
JOB_FILE="$(mktemp)"

# 1. Reset the test site to the canonical pre-edit state.
mkdir -p "$WORKSPACE/services"
cat > "$WORKSPACE/services/index.html" <<'HTML'
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Tjänster — Example Test</title></head>
<body>
<header>
  <h1>Tjänster</h1>
  <p>Vi hjälper företag att växa.</p>
</header>
<main>
  <p>Exempel på tjänster vi erbjuder.</p>
</main>
</body>
</html>
HTML
echo "==> test site reset, initial H1: $(grep -o '<h1>[^<]*</h1>' "$WORKSPACE/services/index.html")"

# 2. Read the Hermes API key from the local Hermes env (never echoed or written).
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
seed_site "$SITE_ID" "https://example.test" "Example Test"
AGENT_CRED="$(create_agent agent_demo "Demo Agent")"
grant_site agent_demo "$SITE_ID"

# 3. Start Relay (separate process).
echo "==> starting relay on $RELAY_ADDR"
RELAY_ADDR="$RELAY_ADDR" SCHEMA_DIR="protocol" RELAY_DB_FILE="$DB" ./bin/relay &
RELAY_PID=$!
wait_relay "$BASE"

# 4. Start the real Hermes adapter (outbound WS to relay, authenticated as agent_demo).
echo "==> starting Hermes adapter"
RELAY_ADDR="$RELAY_ADDR" ADAPTER_AGENT_ID=agent_demo ADAPTER_AGENT_CREDENTIAL="$AGENT_CRED" \
  ADAPTER_MODE=hermes ADAPTER_WORKSPACE="$WORKSPACE" \
  HERMES_BASE_URL="$HERMES_BASE" HERMES_MODEL="hermes-agent" \
  ./bin/adapter >"$ADAPTER_LOG" 2>&1 &
ADAPTER_PID=$!
wait_adapter "$ADAPTER_LOG"

# 5. Pair a Device and run the scripted client (Hermes edit + verify can take a while).
echo "==> pair Device"
read -r DEVICE_ID CRED < <(pair_device "$BASE" "$SITE_ID")
echo "==> running client"
regen_fixture protocol/fixtures/example-job.json "$DEVICE_ID" "$SITE_ID" >"$JOB_FILE"
RELAY_ADDR="$RELAY_ADDR" CLIENT_TIMEOUT=240 DEVICE_CREDENTIAL="$CRED" JOB_FIXTURE="$JOB_FILE" ./bin/client

# 6. Show the final H1.
echo "==> final H1: $(grep -o '<h1>[^<]*</h1>' "$WORKSPACE/services/index.html")"
