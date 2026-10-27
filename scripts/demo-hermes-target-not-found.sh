#!/usr/bin/env bash
# Ulla-Bella Task 07 — real-adapter failure test: target not found.
# Resets the test page so "Tjänster" is absent, submits the canonical Job, and
# asserts the adapter returns error (never done).
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/lib.sh

RELAY_ADDR="${RELAY_ADDR:-127.0.0.1:8787}"
BASE="http://$RELAY_ADDR"
SITE_ID="site_01j7x9k2m"
WORKSPACE="${WORKSPACE:-/srv/ulla-bella-sites/example.test}"

DB="$(new_db)"
export RELAY_DB_FILE="$DB"
ADAPTER_LOG="$(mktemp)"
JOB_FILE="$(mktemp)"

# Absent target: H1 is "Kontakt", not "Tjänster".
mkdir -p "$WORKSPACE/services"
cat > "$WORKSPACE/services/index.html" <<'HTML'
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Kontakt — Example Test</title></head>
<body>
<header>
  <h1>Kontakt</h1>
  <p>Hör av dig till oss.</p>
</header>
</body>
</html>
HTML
echo "==> test site reset, initial H1: $(grep -o '<h1>[^<]*</h1>' "$WORKSPACE/services/index.html")"

HERMES_API_KEY="$(grep -E '^API_SERVER_KEY=' "$HOME/.hermes/.env" | head -n1 | cut -d= -f2- | tr -d '\r\n"')"
export HERMES_API_KEY

cleanup() {
  trap - EXIT
  [[ -n "${RELAY_PID:-}" ]] && kill "$RELAY_PID" 2>/dev/null || true
  [[ -n "${ADAPTER_PID:-}" ]] && kill "$ADAPTER_PID" 2>/dev/null || true
  rm -rf "$(dirname "$DB")" "$ADAPTER_LOG" "$JOB_FILE"
}
trap cleanup EXIT

build_bins

echo "==> seed Site + Agent"
seed_site "$SITE_ID" "https://example.test" "Example Test"
AGENT_CRED="$(create_agent agent_demo "Demo Agent")"
grant_site agent_demo "$SITE_ID"

RELAY_ADDR="$RELAY_ADDR" SCHEMA_DIR="protocol" RELAY_DB_FILE="$DB" ./bin/relay &
RELAY_PID=$!
wait_relay "$BASE"

RELAY_ADDR="$RELAY_ADDR" ADAPTER_AGENT_ID=agent_demo ADAPTER_AGENT_CREDENTIAL="$AGENT_CRED" \
  ADAPTER_MODE=hermes ADAPTER_WORKSPACE="$WORKSPACE" \
  HERMES_BASE_URL="http://127.0.0.1:8642" HERMES_MODEL="hermes-agent" \
  ./bin/adapter >"$ADAPTER_LOG" 2>&1 &
ADAPTER_PID=$!
wait_adapter "$ADAPTER_LOG"

read -r DEVICE_ID CRED < <(pair_device "$BASE" "$SITE_ID")
regen_fixture protocol/fixtures/example-job.json "$DEVICE_ID" "$SITE_ID" >"$JOB_FILE"

set +e
OUT="$(RELAY_ADDR="$RELAY_ADDR" CLIENT_TIMEOUT=240 DEVICE_CREDENTIAL="$CRED" JOB_FIXTURE="$JOB_FILE" ./bin/client 2>&1)"
RC=$?
set -e

echo "==> client exit code: $RC"
echo "==> client output:"
echo "$OUT"
echo "==> final H1: $(grep -o '<h1>[^<]*</h1>' "$WORKSPACE/services/index.html")"

if [[ "$RC" -ne 0 ]] && ! echo "$OUT" | grep -q "^Done$"; then
  echo "RESULT: PASS (error returned, not done)"
else
  echo "RESULT: FAIL (expected error, got done or unexpected output)"
  exit 1
fi
