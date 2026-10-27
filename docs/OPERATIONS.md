# Ulla-Bella — Operations

How the running Ulla-Bella services are operated. This describes the current deployment
(the infraverket VM `ub-host`). **Do not copy secret values into this document.**
Internal addresses and environment details are noted as internal — scrub them if this
document is ever published publicly.

## Services

Both services run as **user-level systemd** units (`systemctl --user`, user `ulla-bella`):

| Service | Unit | Role |
|---|---|---|
| Relay | `ulla-bella-relay.service` | authenticate Devices/Agents, route Sites to Agents, store Jobs/Results |
| Adapter | `ulla-bella-adapter.service` | outbound WSS to Relay, drive Hermes + the Site tool |

- Relay binds `0.0.0.0:8787` (LAN-reachable for the browser); the Adapter connects to
  `127.0.0.1:8787`.
- Hermes stays on `127.0.0.1:8642` — **never** LAN-exposed.

## Configuration

- **Relay**: environment in the unit file — `RELAY_ADDR`, `RELAY_DB_FILE`,
  `RELAY_PUBLIC_URL`, `SCHEMA_DIR`, and `WorkingDirectory`.
- **Adapter**: `~/.config/ulla-bella/adapter.yaml` (0644) plus
  `~/.config/ulla-bella/adapter.env` (0600). The YAML references secrets by **env-var
  name**; the values live only in the 0600 env file.
- **Adapter run store**: `ADAPTER_RUN_DB` (default `ulla-bella-runs.db`) — the durable
  `jobId`→run mapping the Adapter uses to resume in-flight jobs after a restart.

Secret values (Relay/Adapter/Hermes/Site-tool tokens) are never printed or committed.

## Network flows

```
Browser (Chrome extension)   --HTTPS-->  Relay :8787
Adapter                        --WSS-->  Relay :8787   (outbound)
Adapter                        --HTTP-->  Hermes :8642 (loopback only)
Adapter                        --REST-->  Site tool (EmDash API / YOOtheme MCP)
```

## Start / stop / status

```bash
systemctl --user status ulla-bella-relay ulla-bella-adapter
systemctl --user restart ulla-bella-relay
systemctl --user restart ulla-bella-adapter
```

Over non-interactive SSH, export `XDG_RUNTIME_DIR=/run/user/$(id -u)` before any
`systemctl --user` command.

## Health

- Relay: `GET /healthz` and `GET /readyz` return 200.
- After a Relay restart the Adapter reconnects within ~1s; the Relay log shows
  `adapter connected: agentId=... sites=[...]`.
- Adapter: `ulla-bella-adapter --config ... --env-file ... doctor` checks Relay, Hermes,
  credential and Site-tool health without editing and without printing secret values.

## Logs

```bash
journalctl --user -u ulla-bella-relay -f
journalctl --user -u ulla-bella-adapter -f
```

Access logs never print headers, bodies or credentials.

## Backup

Back up, at minimum:

- The Relay SQLite database (`RELAY_DB_FILE`).
- The Adapter run store (`ADAPTER_RUN_DB`) — jobId→run mapping for recovery.
- `~/.config/ulla-bella/adapter.yaml` and `adapter.env` (0600).
- Any Hermes skill/config the Adapter depends on (e.g. the `infraverket` skill).

## Update & rollback

1. Back up the current binaries and config (above).
2. Build the new binary on dev-host (Go), then `scp` it to the VM.
3. Stop the service, replace the binary, start it. The running binary is busy
   (`ETXTBSY`), so you **cannot** overwrite it in place — stop first.
4. Verify with `doctor` and `journalctl --user -u ...`.
5. Rollback = restore the backup files and restart both services.

## A new installation

See [`ADAPTER_INSTALL.md`](ADAPTER_INSTALL.md) and [`RELAY.md`](RELAY.md).
The repo ships `deploy/*` + `scripts/install-adapter.sh` targeting the system-level
layout (`/etc/ulla-bella/`, user `ullabella`).

## Fixed (2026-10-15, commit `78afc08`)

- **Relay write-deadline pollution** — a 10 s write deadline set by the ping loop used to
  persist on the shared adapter connection, so a job forwarded later failed with `i/o
  timeout`. Pings now use `WriteControl` and every data write resets its own deadline.
- **Job persisted before delivery** — a failed forward records a terminal
  `delivery_uncertain` error, never a stuck `accepted` and never a delete (a TCP write
  failure does not prove the adapter missed the job). See `docs/HERMES-ASYNC.md`.

## Durable execution & recovery (Task 4A + 4A.1, 2026-10-15)

The Adapter executes each job as a **durable Hermes run** (submit → poll → final result)
instead of one synchronous call, and persists a `jobId`→run mapping in `ADAPTER_RUN_DB`.
On every (re)connection it reconciles the store: `received` jobs are re-admitted
idempotently, `running` jobs are resumed by their persisted run id, and terminal results
are re-delivered. The Relay leaves `working` jobs alone across a restart (the Adapter
recovers them) and interrupts only `accepted` jobs. Full design: `docs/HERMES-ASYNC.md`.

- `ADAPTER_RUN_DB` — the run-store path (default `ulla-bella-runs.db`).
- `ADAPTER_ADMISSION_GRACE` — how long an `admission_in_flight` record may be re-admitted
  (default `23h`; Hermes's idempotency reservation is 24 h). Past the grace the job is
  marked `admission_uncertain` for manual review — never auto re-run.

**Coordinated deploy:** the Adapter binary and the Relay binary must deploy in the same
window — the Relay's `accepted`-only interrupt is safe only because the Adapter now
recovers `working` jobs.

## Deployment (Task 4A)

Controlled update of Relay + Adapter on `ub-host`. Deploy only after the readiness
report is approved. **No content changes on infraverket.eu.**

**Preflight**
1. Branch `feat/infraverket-emdash` at `059e281` (or later) on dev-host.
2. `go build ./... && go vet ./... && go test ./... -count=1` green.
3. Hermes `GET /health` = 200; `ulla-bella-adapter … doctor` = Relay/Hermes/site OK.

**Backup (before any change)**
- `~/.config/ulla-bella/` (adapter.yaml + adapter.env) and both binaries.
- The Relay DB (`RELAY_DB_FILE`) and the Adapter run store (`ADAPTER_RUN_DB`) — copy the
  files, not just the WAL sidecars.
- Record the Relay job table state (statuses + jobIds).

**Config changes**
- Adapter unit: set `ADAPTER_RUN_DB` (e.g. `~/.local/share/ulla-bella/runs.db`),
  optionally `ADAPTER_ADMISSION_GRACE`. No other env changes.

**Active jobs**
- Drain in-flight jobs first, or accept that `accepted` jobs are interrupted on Relay
  restart and `working` jobs are resumed by the new Adapter.

**Install order (one coordinated window)**
1. Build both binaries on dev-host (adapter with `-X main.version=…`).
2. `systemctl --user stop ulla-bella-adapter ulla-bella-relay`.
3. `scp` the binaries (stop first — the running binary is `ETXTBSY`).
4. Apply the `ADAPTER_RUN_DB` config.
5. `systemctl --user start ulla-bella-relay`, then `ulla-bella-adapter`.

**Readiness checks**
- `/healthz` and `/readyz` = 200; Relay log shows `adapter connected: agentId=… sites=[…]`.
- `doctor` = all OK; Adapter log shows it opened `ADAPTER_RUN_DB` without error.

**Run-admission + recovery test (real Hermes, no site edits)**
- Admit a harmless text task via `POST /v1/runs`, poll to `completed`, read the result
  (see the smoke-test definition in the readiness report).
- Restart the Adapter mid-run; confirm it resumes the **same** `run_id` (a single
  `POST /v1/runs` in the log, no second admission).
- Restart the Relay; confirm a `working` job is recovered, not failed.

**Rollback (preserve known job identities; never double-execute)**
- Restore the backed-up binaries + config + **both** DBs together, then restart both
  services.
- Do not blind-restore one DB alone: a Relay DB restored to before a job ran, combined
  with a run store that still knows the `run_id`, can lose or double-track a job. If a run
  was admitted after the backup and the run store no longer matches, **do not downgrade** —
  roll forward instead and document the limitation.

## Deployed (2026-10-15, Task 4A.2)

Durable Hermes Runs is live on `ub-host`. Verified end-to-end and with restart
recovery (see below).

- **Versions:** Adapter `0.13.0` (commit `d9d5695`), Relay (commit `d9d5695`), built on
  dev-host and scp'd to the VM.
- **Relay:** `~/ulla-bella/bin/relay`, unit `ulla-bella-relay.service` (unchanged).
- **Adapter:** `~/.local/bin/ulla-bella-adapter`, unit `ulla-bella-adapter.service` now sets
  `Environment=ADAPTER_RUN_DB=%h/.config/ulla-bella/runs.db`.
- **Run store:** `~/.config/ulla-bella/runs.db` (SQLite, table `runs`).
- **New site:** `site_fs_test` (origin `https://example.test`, `filesystem` tool type,
  workspace `/srv/ulla-bella-sites/example.test`) — an isolated synthetic test
  site with **no** production access, used for the integration and recovery tests. The
  `filesystem` tool type was added in `d9d5695`.
- **Backup:** `~/ulla-bella-backup-20261015-212501/` (binaries, config, Relay DB, units).

**Verified against the real Hermes gateway:**

- **Smoke test** (`POST /v1/runs` + poll): `run_ef6b68c250b54628ab6828f2d1a5664b`,
  `running → completed`, output `OK`; idempotent re-admission returned the same run.
- **Integration test** (Relay → Adapter → Hermes Runs → Adapter → Relay, filesystem test
  site): `accepted → working → done`, H1 `Services 12345 → Our Services`, idempotent
  re-submit returned the stored `done` (no re-execution).
- **Adapter restart recovery:** `run_51d0a040fb0645b696be55dbf3fff9bc` resumed with the
  **same** `run_id` after restart (no second run); result delivered.
- **Relay restart recovery:** a `working` job survived the restart (no false
  `relay_restarted`), the Adapter reconnected and delivered `done`.

## Deployed (2026-10-16, Task 4B — live agent activity)

Live agent activity is surfaced to the Chrome panel, driven by Hermes's poll-status
`last_event`/`updated_at` (no SSE). The Adapter maps them to a controlled vocabulary and
forwards each snapshot as an additive `activity` object on the `working` Result; the Relay
stores it and `GET /v1/jobs/{jobId}` returns it. Raw Hermes tool names/previews never
leave the Adapter. See `docs/HERMES-ASYNC.md`.

- **Adapter** rebuilt (commit `8ea4f2f`, version `0.13.0`) at
  `~/.local/bin/ulla-bella-adapter`.
- **Relay** — **schema-only change**: `protocol/result.schema.json` gains the additive
  `activity` field, so the Relay binary was NOT rebuilt; redeploy the schema file and
  restart the Relay to reload it (the Relay validates Results at WS ingest).
- **Coordinated deploy order:** stop adapter → scp new adapter binary + schema → restart
  relay (reloads schema) → start adapter.
- **Backup:** `~/ulla-bella-backup-20261016-050927/`.
- **Verified live:** a `site_fs_test` job (`job_act_1792127486`) showed `working` with
  `activity` snapshots (`working` → `using_tools` → …) while Hermes ran, then terminal
  `done` with `verification.status=passed` and the H1 confirmed changed to
  `Services Activity Verified 1792127486`. No double execution.

## Deployed (2026-10-16, Task 4B.1 — admission recovery + terminal safety)

- **Adapter** rebuilt (commit `221b4b6`, version `0.13.0`) — `submitRun` retries an
  UNCERTAIN admission failure (network error / 5xx) up to 5× with the SAME
  `Idempotency-Key` + identical payload (bounded backoff 500 ms → 4 s); a definitive 4xx
  (409 conflict) fails immediately. `ADAPTER_ADMISSION_GRACE` (23 h) still gates
  restart-time re-admission; `attempted_at` is never reset.
- **Relay** rebuilt (commit `221b4b6`) — `SetJobResult` now enforces the terminal-state
  invariant: a late `accepted`/`working` result never overwrites a settled `done`/`error`
  (ignored + logged); terminal results redeliver idempotently.
- **Backup:** `~/ulla-bella-backup-20261016-053852/` (both binaries, config, schema,
  units, Relay DB + WAL, run store). Pre-deploy active-job check: 0 non-terminal jobs.
- **Verified live:** a `site_fs_test` job (`job_act_1792129170`) ran end-to-end on the new
  binaries — `accepted → working (activity) → done`, H1 changed, postcondition passed, no
  double execution; the 14 pre-existing terminal jobs were preserved.
- **Rollback:** restore the backup binaries + config + BOTH DBs together, then restart
  both services (never restore one DB alone).

## Test site (Task 5 UAT)

Isolated filesystem site for the user-acceptance test — fully separate from infraverket.eu.

- **Site:** `site_fs_test2`, origin `http://site.example.com:8080`, adapter `tool.type: filesystem`,
  workspace `~/ulla-bella-test-sites/example.test` (on ub-host).
- **Page server:** `python3 -m http.server 8080 --bind 0.0.0.0` from the workspace dir
  (started with `nohup`, log `/tmp/ub-site.log`). The origin uses the LAN IP + high port
  because the service user cannot bind 443 (`ip_unprivileged_port_start = 1024`) — the
  original `site_fs_test` origin `https://example.test` is therefore unreachable as-is.
- **Invite:** `~/ulla-bella-invites/fs-test-http.ullabella` (minted with
  `RELAY_PUBLIC_URL=https://relay.example.com`).
- **Reach Chrome:** navigate to `http://site.example.com:8080/`, import the `.ullabella` in the
  extension popup, grant the host permission, then annotate. Reload the page to see edits.
- The workspace `index.html` holds the test content (three headings, paragraphs, `<hr>`, a
  button). The filesystem postcondition only checks H1.

## Chrome extension monitoring

The extension polls `GET /v1/jobs/{jobId}` every 500 ms while a job runs, with a `chrome.alarms`
tick (1 min) plus a resume on every service-worker start as the recovery path. A transient
network error marks the job `paused` (not failed) and resumes via the alarm. The client
poll has no fixed "job failed" timeout — a client pause never implies the server job
failed. See `docs/JOB_PROGRESS_UX.md`.

## Timeouts & reconnection

- Relay ping period 54 s, pong wait 60 s, write wait 10 s.
- Adapter reconnects ~1 s after a WS drop (backoff 1→2→4→8→16 s).
- Extension `POLL_TIMEOUT_MS = 360000` (6 min); it retries `agent_unavailable` up to 2×.
- Adapter executes jobs as durable Hermes runs (submit → poll); there is no fixed
  HTTP edit timeout. Run-status polling uses a 30 s client with a 2 s poll interval.

## Versioned service-file templates

The unit files used by a user-level (`systemctl --user`) install are shown in
[`ADAPTER_INSTALL.md`](ADAPTER_INSTALL.md). The system-level templates already live under
`deploy/`; copy them into your own repository so an installation stays reproducible.
