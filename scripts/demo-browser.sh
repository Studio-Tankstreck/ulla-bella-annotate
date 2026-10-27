#!/usr/bin/env bash
# Ulla-Bella Task 08 — browser-path demo. Runs ON ub-host (next to Hermes).
#
#   scripts/demo-browser.sh          # automated E2E: scripted client -> backend
#   scripts/demo-browser.sh --keep   # manual E2E: start stack, keep running for Chrome
#
# Topology:
#   Chrome -> Relay(0.0.0.0:8787) <- Hermes Adapter -> Hermes(127.0.0.1:8642)
#   plus a static server (0.0.0.0:8080) serving the test-site workspace.
# Hermes stays local; only 8787/8080 are intended to be exposed for the browser
# demo (see docs/RELAY.md). The automated mode reaches the relay via localhost,
# so it needs no firewall change at all.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib.sh

KEEP_RUNNING=0
[[ "${1:-}" == "--keep" ]] && KEEP_RUNNING=1

RELAY_BIND="${RELAY_BIND:-0.0.0.0:8787}"     # what the relay listens on
RELAY_ADDR="${RELAY_ADDR:-127.0.0.1:8787}"   # how adapter/client/curl reach it
BASE="http://$RELAY_ADDR"
SITE_ID="site_01j7x9k2m"
SITE_ORIGIN="${SITE_ORIGIN:-http://site.example.com:8080}"
SITE_PORT="${SITE_PORT:-8080}"
WORKSPACE="${WORKSPACE:-/srv/ulla-bella-sites/example.test}"
HERMES_BASE="${HERMES_BASE:-http://127.0.0.1:8642}"
JOB_FIXTURE="${JOB_FIXTURE:-protocol/fixtures/browser-job.json}"
CLIENT_TIMEOUT="${CLIENT_TIMEOUT:-240}"

DB="$(new_db)"
export RELAY_DB_FILE="$DB"
ADAPTER_LOG="$(mktemp)"
JOB_FILE="$(mktemp)"

RELAY_PID=""
ADAPTER_PID=""
SITE_PID=""

reset_site() {
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
  echo "==> site reset, H1: $(grep -o '<h1>[^<]*</h1>' "$WORKSPACE/services/index.html")"
}

cleanup() {
  trap - EXIT
  [[ -n "$ADAPTER_PID" ]] && kill "$ADAPTER_PID" 2>/dev/null || true
  [[ -n "$RELAY_PID" ]] && kill "$RELAY_PID" 2>/dev/null || true
  [[ -n "$SITE_PID" ]] && kill "$SITE_PID" 2>/dev/null || true
  rm -rf "$(dirname "$DB")" "$ADAPTER_LOG" "$JOB_FILE"
}
trap cleanup EXIT

# --- load Hermes key (never echoed or written to disk) ---
HERMES_API_KEY="$(grep -E '^API_SERVER_KEY=' "$HOME/.hermes/.env" | head -n1 | cut -d= -f2- | tr -d '\r\n"' )"
[[ -n "$HERMES_API_KEY" ]] || { echo "ERROR: no API_SERVER_KEY in ~/.hermes/.env" >&2; exit 1; }
export HERMES_API_KEY

reset_site
build_bins

echo "==> seed Site + Agent (origin=$SITE_ORIGIN)"
seed_site "$SITE_ID" "$SITE_ORIGIN" "Example Test"
AGENT_CRED="$(create_agent agent_demo "Demo Agent")"
grant_site agent_demo "$SITE_ID"

echo "==> static server 0.0.0.0:$SITE_PORT -> $WORKSPACE"
( cd "$WORKSPACE" && exec python3 -m http.server "$SITE_PORT" --bind 0.0.0.0 ) &
SITE_PID=$!

echo "==> relay bind $RELAY_BIND (SITE_ORIGIN=$SITE_ORIGIN)"
RELAY_ADDR="$RELAY_BIND" SCHEMA_DIR="protocol" RELAY_DB_FILE="$DB" ./bin/relay &
RELAY_PID=$!
wait_relay "$BASE"

echo "==> Hermes adapter (mode=hermes, -> $HERMES_BASE)"
RELAY_ADDR="$RELAY_ADDR" ADAPTER_AGENT_ID=agent_demo ADAPTER_AGENT_CREDENTIAL="$AGENT_CRED" \
  ADAPTER_MODE=hermes ADAPTER_WORKSPACE="$WORKSPACE" \
  SITE_ORIGIN="$SITE_ORIGIN" HERMES_BASE_URL="$HERMES_BASE" HERMES_MODEL="hermes-agent" \
  ./bin/adapter >"$ADAPTER_LOG" 2>&1 &
ADAPTER_PID=$!
wait_adapter "$ADAPTER_LOG"

if [[ "$KEEP_RUNNING" == "1" ]]; then
  echo
  echo "==> dev stack ready. For the manual Chrome E2E:"
  echo "    Site:  http://relay.example.com:$SITE_PORT/services"
  echo "    Relay: https://relay.example.com (extension relayBaseUrl)"
  echo "    Create an invite + import it in the extension:"
  echo "      ./bin/relay invite create $SITE_ID --ttl 24h --out ."
  echo "    Then load extension/ unpacked, open the Site, hover + click the H1,"
  echo "    type the change, Send. Ctrl-C to stop."
  wait
else
  echo "==> pair Device + scripted client -> $JOB_FIXTURE"
  read -r DEVICE_ID CRED < <(pair_device "$BASE" "$SITE_ID")
  regen_fixture "$JOB_FIXTURE" "$DEVICE_ID" "$SITE_ID" >"$JOB_FILE"
  RELAY_ADDR="$RELAY_ADDR" CLIENT_TIMEOUT="$CLIENT_TIMEOUT" DEVICE_CREDENTIAL="$CRED" JOB_FIXTURE="$JOB_FILE" ./bin/client
  echo "==> served page H1: $(curl -fsSL "http://127.0.0.1:$SITE_PORT/services" | grep -o '<h1>[^<]*</h1>')"
  echo "==> file H1:        $(grep -o '<h1>[^<]*</h1>' "$WORKSPACE/services/index.html")"
fi
