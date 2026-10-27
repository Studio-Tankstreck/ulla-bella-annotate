#!/usr/bin/env bash
# Task 12 — private-beta scripted lifecycle (no Chrome GUI). Proves the full
# operator flow on SQLite: create Site -> create Agent -> grant -> live Invite ->
# pair Device -> authenticated Adapter -> Job -> Result -> Done, then Relay
# restart survival, then Device revoke. StubExecutor stands in for the agent
# (the real CMS edit loop is already proven in Task 09B). No secret is printed.
#
#   scripts/demo-private-beta.sh
#
# Exits 0 and prints "PRIVATE-BETA LIFECYCLE: PASS" on success.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib.sh

RELAY_ADDR="${RELAY_ADDR:-127.0.0.1:8787}"
BASE="http://$RELAY_ADDR"
SITE_ID="site_01j7x9k2m"
SITE_ORIGIN="https://example.test"

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

fail() { echo "FAIL: $1" >&2; exit 1; }

echo "==> build"
build_bins

echo "==> create Site"
seed_site "$SITE_ID" "$SITE_ORIGIN" "Example Test"

echo "==> create Agent + grant Site"
AGENT_CRED="$(create_agent agent_demo "Demo Agent")"
[[ -n "$AGENT_CRED" ]] || fail "no agent credential minted"
grant_site agent_demo "$SITE_ID"

echo "==> start Relay"
RELAY_ADDR="$RELAY_ADDR" SCHEMA_DIR=protocol RELAY_DB_FILE="$DB" ./bin/relay &
RELAY_PID=$!
wait_relay "$BASE"

echo "==> start authenticated Adapter (stub)"
ADAPTER_MODE=stub RELAY_ADDR="$RELAY_ADDR" ADAPTER_AGENT_ID=agent_demo ADAPTER_AGENT_CREDENTIAL="$AGENT_CRED" \
  ./bin/adapter >"$ADAPTER_LOG" 2>&1 &
ADAPTER_PID=$!
wait_adapter "$ADAPTER_LOG"

echo "==> pair Device (live invite mint + redeem)"
read -r DEVICE_ID CRED < <(pair_device "$BASE" "$SITE_ID")
[[ -n "$DEVICE_ID" && -n "$CRED" ]] || fail "pair produced no device/credential"

echo "==> Device submits Job -> Result -> Done"
regen_fixture protocol/fixtures/example-job.json "$DEVICE_ID" "$SITE_ID" >"$JOB_FILE"
RELAY_ADDR="$RELAY_ADDR" DEVICE_CREDENTIAL="$CRED" JOB_FIXTURE="$JOB_FILE" ./bin/client

echo "==> live Invite while Relay is running (Part 5)"
read -r DEV2 CRED2 < <(pair_device "$BASE" "$SITE_ID")
[[ -n "$DEV2" && -n "$CRED2" ]] || fail "live invite failed"

echo "==> restart survival: stop Relay + Adapter, restart both on same DB"
kill "$RELAY_PID" 2>/dev/null || true
kill "$ADAPTER_PID" 2>/dev/null || true
wait "$RELAY_PID" 2>/dev/null || true
wait "$ADAPTER_PID" 2>/dev/null || true
RELAY_ADDR="$RELAY_ADDR" SCHEMA_DIR=protocol RELAY_DB_FILE="$DB" ./bin/relay &
RELAY_PID=$!
wait_relay "$BASE"
: >"$ADAPTER_LOG"   # truncate so wait_adapter sees only the fresh registration
ADAPTER_MODE=stub RELAY_ADDR="$RELAY_ADDR" ADAPTER_AGENT_ID=agent_demo ADAPTER_AGENT_CREDENTIAL="$AGENT_CRED" \
  ./bin/adapter >"$ADAPTER_LOG" 2>&1 &
ADAPTER_PID=$!
wait_adapter "$ADAPTER_LOG"

echo "==> Device credential still works after restart"
regen_fixture protocol/fixtures/example-job.json "$DEVICE_ID" "$SITE_ID" >"$JOB_FILE"
RELAY_ADDR="$RELAY_ADDR" DEVICE_CREDENTIAL="$CRED" JOB_FIXTURE="$JOB_FILE" ./bin/client

echo "==> revoke Device"
./bin/relay device revoke "$DEVICE_ID"

echo "==> revoked credential can no longer submit (expect 401)"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/jobs" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $CRED" \
  --data @"$JOB_FILE")"
[[ "$CODE" == "401" ]] || fail "revoked device still authorized (HTTP $CODE)"

echo ""
echo "PRIVATE-BETA LIFECYCLE: PASS"
