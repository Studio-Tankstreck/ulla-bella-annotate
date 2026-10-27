#!/usr/bin/env bash
# Ulla-Bella private-beta demo/smoke helpers (Task 12+). Sourced, not run.
#
# Replaces the Task 06-11 dev-registry flow (static agent_demo / RELAY_STATE_FILE
# JSON store) with the SQLite store + authenticated agent. No secret is ever
# printed: the agent/device credentials are captured into shell variables only.
#
# Caller contract:
#   export RELAY_DB_FILE=<db path>   before seed_site/create_agent/grant_site/pair_device
#   RELAY_ADDR (default 127.0.0.1:8787) for wait_relay/pair_device

# build_bins — compile relay/adapter/client into bin/.
build_bins() {
  # Go is user-space at ~/.local/go on dev-host (no sudo). Prepending is
  # idempotent and harmless where Go is already on PATH.
  export PATH="$HOME/.local/go/bin:$PATH"
  mkdir -p bin
  go build -o bin/relay ./relay
  go build -o bin/adapter ./hermes-adapter
  go build -o bin/client ./client
}

# new_db — print a fresh temp SQLite DB path (caller owns cleanup).
new_db() { echo "$(mktemp -d)/ulla-bella.db"; }

# seed_site <siteId> <origin> <name>
seed_site() { ./bin/relay site create "$1" --origin "$2" --name "$3" >/dev/null; }

# create_agent <agentId> <name> — echoes the raw credential once (caller captures it).
create_agent() {
  ./bin/relay agent create "$1" --name "$2" | grep -o 'uba_[0-9a-f]\{64\}'
}

# grant_site <agentId> <siteId>
grant_site() { ./bin/relay agent grant-site "$1" "$2" >/dev/null; }

# wait_relay <base> — poll /healthz until the relay is up.
wait_relay() {
  local base="$1" ready=0
  for _ in $(seq 1 50); do
    curl -fsS "$base/healthz" >/dev/null 2>&1 && { ready=1; break; }
    sleep 0.1
  done
  [[ "$ready" == 1 ]] || { echo "relay not ready" >&2; exit 1; }
}

# wait_adapter <logfile> — poll the adapter log for a successful registration.
wait_adapter() {
  local logf="$1" ready=0
  for _ in $(seq 1 50); do
    grep -q "registered" "$logf" 2>/dev/null && { ready=1; break; }
    sleep 0.1
  done
  [[ "$ready" == 1 ]] || { echo "adapter not registered (see $logf)" >&2; exit 1; }
}

# pair_device <base> <siteId> — mint a live invite + redeem it, echoing
# "<deviceId> <deviceCredential>". The invite token exists only inside the
# temporary .ullabella file here and is never printed.
pair_device() {
  local base="$1" site="$2" out token resp
  out="$(mktemp -d)"
  RELAY_PUBLIC_URL="$base" ./bin/relay invite create "$site" --ttl 1h --out "$out" >/dev/null
  token="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["invite"])' "$out"/*.ullabella)"
  resp="$(curl -sS -X POST "$base/v1/pair" -H 'Content-Type: application/json' --data "{\"invite\":\"$token\"}")"
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(d["deviceId"], d["deviceCredential"])' "$resp"
  rm -rf "$out"
}

# regen_fixture <fixture> <deviceId> [siteId] — rewrite a fixture's payload with
# the paired deviceId (and optional siteId), printing JSON to stdout.
#
# Every regeneration is a NEW round, so the jobId and the envelope message id get
# a fresh value. Re-posting an unchanged payload is idempotent by design (the
# Relay answers 200 with the stored result instead of accepting the job a second
# time), so a script that then asserts "accepted" must never reuse them.
regen_fixture() {
  python3 - "$1" "$2" "${3:-}" <<'PY'
import json,sys,time
p=json.load(open(sys.argv[1]))
p["payload"]["deviceId"]=sys.argv[2]
if sys.argv[3]:
    p["payload"]["siteId"]=sys.argv[3]
suffix=format(time.time_ns() % 0xffffffff, "08x")
p["payload"]["jobId"]="job_"+suffix
p["id"]="msg_"+suffix
print(json.dumps(p))
PY
}
