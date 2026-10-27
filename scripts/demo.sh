#!/usr/bin/env bash
# Ulla-Bella Task 06 — wire-slice E2E (stub). Proves the authenticated round
# trip with the Task 12 backend: Site -> Agent -> grant -> pair -> Job -> Done.
# StubExecutor stands in for the agent. Must print "Done" and exit 0.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib.sh

RELAY_ADDR="${RELAY_ADDR:-127.0.0.1:8787}"
BASE="http://$RELAY_ADDR"
SITE_ID="site_01j7x9k2m"

DB="$(new_db)"
export RELAY_DB_FILE="$DB"
ADAPTER_LOG="$(mktemp)"
JOB_FILE="$(mktemp)"

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

echo "==> start Relay"
RELAY_ADDR="$RELAY_ADDR" SCHEMA_DIR=protocol RELAY_DB_FILE="$DB" ./bin/relay &
RELAY_PID=$!
wait_relay "$BASE"

echo "==> start Adapter (stub)"
ADAPTER_MODE=stub RELAY_ADDR="$RELAY_ADDR" ADAPTER_AGENT_ID=agent_demo ADAPTER_AGENT_CREDENTIAL="$AGENT_CRED" \
  ./bin/adapter >"$ADAPTER_LOG" 2>&1 &
ADAPTER_PID=$!
wait_adapter "$ADAPTER_LOG"

echo "==> pair Device"
read -r DEVICE_ID CRED < <(pair_device "$BASE" "$SITE_ID")

echo "==> run client (expect Done)"
regen_fixture protocol/fixtures/example-job.json "$DEVICE_ID" "$SITE_ID" >"$JOB_FILE"
RELAY_ADDR="$RELAY_ADDR" DEVICE_CREDENTIAL="$CRED" JOB_FIXTURE="$JOB_FILE" ./bin/client
