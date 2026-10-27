# Ulla-Bella — Reliable long-running Hermes jobs

**Status:** implemented + hardened (Task 4A + 4A.1, 2026-10-15; live activity in
Task 4B, and admission recovery + terminal safety in Task 4B.1, 2026-10-16) · commits `b1cb54d`, `178f5c9`, `ee17a88`, `059e281` + Task 4B/4B.1 ·
branch `feat/infraverket-emdash`. This document supersedes the earlier research-only
version (commit `2e12e9d`): the durable `/v1/runs` execution path is wired into the
Adapter with restart recovery, a fail-closed idempotency rule for Hermes's 24 h
reservation retention, live agent activity surfaced to Chrome, and is covered by tests.

---

## What changed

The Adapter previously executed every job with **one synchronous, non-streaming**
`POST /v1/chat/completions` using `http.Client{Timeout: 5 * time.Minute}`. Any job that
outlived five minutes (or any disconnect) lost its result, even though Hermes kept
working server-side.

The Adapter now drives Hermes's **durable `/v1/runs` API**:

1. `POST /v1/runs` — admit a run; returns a `run_id` immediately (202).
2. `GET /v1/runs/{run_id}` — poll status; on completion carries the `output` field
   (the final response text); while running it carries `last_event` + `updated_at`
   (the live activity signal Task 4B uses).
3. `GET /v1/runs/{run_id}/events` — SSE activity (explored in Task 4B; not used — the
   poll-status `last_event`/`updated_at` field carries the same signal without SSE).
4. `POST /v1/runs/{run_id}/stop` — cancel.

The `output` field is fed through the **unchanged** outcome parser and deterministic
postcondition (`hermes-adapter/hermes.go` `finalize`), so Hermes's self-report is never
the sole proof of success — exactly as before.

## Verified Hermes API behavior

Verified against the installed `ub-host` Hermes (source
`~/.hermes/hermes-agent`, commit `79af3f6`): `gateway/platforms/api_server_runs.py`,
`api_server_run_idempotency.py`, `api_server.py`. Nothing below is assumed.

### `POST /v1/runs`

- Auth: `Authorization: Bearer <API_SERVER_KEY>` (same as `/v1/chat/completions`; the
  handler is wrapped by `_admit_api_agent_request`).
- Body: `{"model": "...", "input": "<prompt>"}`. A string `input` becomes a single user
  message; `instructions` is an optional ephemeral system prompt.
- Response 202: `{"run_id": "run_<hex>", "status": "started", "replayed": false}`.
- **Idempotency:** an `Idempotency-Key` header (1–255 visible ASCII) is supported and
  durable. `reserve()` inserts a `(scope, key)` row under `BEGIN IMMEDIATE`; a re-POST
  with the same key and identical body returns the **same** `run_id` (202 with
  `Idempotency-Replayed: true`); the same key with a different body returns 409
  `idempotency_key_conflict`. The scope is a hash of `(profile, api_key)`, and the
  fingerprint is a SHA-256 of the parsed request body. Reservations live in
  `runs_idempotency.db` and are retained 24 h (pruned only once terminal).

### `GET /v1/runs/{run_id}`

Returns the pollable status dict: `status` ∈ `queued | running | waiting_for_approval |
stopping | completed | failed | cancelled | interrupted`, plus `output` (on
`completed`), `error`, `usage`, `runtime`, timestamps. Ownership is scoped: a foreign or
unknown run returns 404 `run_not_found`.

### Restart guarantees

- Run admission is durable: a crash between `POST /v1/runs` and persisting the `run_id`
  is recovered by re-POSTing with the same `Idempotency-Key` → the original `run_id`.
- A non-terminal run whose owner process died is reported `interrupted` (fail-closed),
  never silently left "running".
- The idempotency reservation is retained 24 h; see *Known limitations* below.

## Live activity (Task 4B)

Hermes exposes two activity surfaces (verified in `gateway/platforms/api_server_runs.py`):

- **SSE** `GET /v1/runs/{run_id}/events` — structured lifecycle events (`tool.started`,
  `tool.completed`, `reasoning.available`, `message.interim`, `subagent.start`/
  `subagent.complete`, `approval.request`, `run.interrupted`). Payloads are
  secret-redacted; `tool.completed` previews are bounded to 500 chars. It supports a
  cursor (`Last-Event-ID` header or `?last_seq=N`) that replays the last ~1000 events,
  but the backlog is in-memory with a **300 s TTL** — not durable across a Hermes
  restart.
- **Poll status** `GET /v1/runs/{run_id}` — the status dict carries `last_event` (the
  latest event name) and `updated_at` (bumped on every event/status change). This is the
  **live activity signal without SSE**: the Adapter already polls it every ~2 s.

The Adapter reads `last_event` + `updated_at` while polling and maps them to a controlled
activity vocabulary — `starting` / `working` / `using_tools` / `thinking` /
`waiting_for_approval` / `verifying` ("verifying" is adapter-only, from the deterministic
postcondition). It forwards each snapshot as an additive `activity` object on the
non-terminal `working` Result; the Relay stores it (last-write-wins) and the browser reads
it via `GET /v1/jobs/{jobId}`. Raw Hermes tool names, previews and event internals are
**never** forwarded. See `docs/JOB_PROGRESS_UX.md`.

## Durable job mapping

The Adapter persists a `jobId → run_id` mapping (plus the raw Job payload) in its own
SQLite store (`ADAPTER_RUN_DB`, default `ulla-bella-runs.db`; schema in
`hermes-adapter/runstore.go`). Records move through a three-state admission lifecycle
before reaching a terminal state:

- **received** — job persisted, admission **never attempted** (provably unsent). Safe to
  re-admit at any age: the first run is still the only run.
- **admission_in_flight** — `submitRun` was attempted but the `run_id` was not yet
  persisted. The admission outcome is UNKNOWN; this state is entered by
  `MarkAdmissionInFlight` **before** the HTTP submit.
- **running** — `run_id` persisted, run in flight.
- **done | error** — terminal; the Result envelope is kept for idempotent re-delivery.

`Idempotency-Key` is `"ub-" + sha256(jobId)` — always ASCII-safe and deterministic per
job, so a re-admission after a crash resolves to the same run.

## Restart recovery

On every (re)connection the Adapter reconciles its run store (`hermes-adapter/main.go`
`reconcile`). A `recoveryGuard` single-flights each job so two overlapping reconcile
passes (back-to-back reconnects) never run competing admission attempts:

- **received** → re-admit via the idempotent `submitRun` (never a duplicate).
- **admission_in_flight** → re-admit only within the admission grace window; past it,
  mark `admission_uncertain` (manual review) — never auto re-admit.
- **running** → resume polling the persisted `run_id` (`HermesExecutor.Resume`), which
  works even after 24 h (a non-terminal run's status is never pruned).
- **done | error** → re-deliver the stored Result (idempotent: the Relay overwrites).

The Relay's `InterruptNonTerminal` now interrupts **only** `accepted` jobs (the Adapter
never confirmed receipt); `working` jobs are left for the Adapter to resume, so a Relay
restart no longer falsely marks a recoverable run as `relay_restarted`. See
`docs/OPERATIONS.md` and commit `178f5c9`.

### The 24 h idempotency boundary

Hermes retains an idempotency reservation for **24 h** (`RETENTION_SECONDS =
ACKNOWLEDGED_RETENTION_SECONDS = 24*60*60`) and prunes it **only once the run is
terminal**. A non-terminal run's row is never pruned, so re-admission with the same key
is safe for at least 24 h from admission.

The Adapter closes the residual window with a **grace period** (`ADAPTER_ADMISSION_GRACE`,
default **23 h** — a 1 h margin): an `admission_in_flight` record whose `attempted_at` is
older than the grace is never re-admitted — it is marked `admission_uncertain` for manual
review. `received` records are exempt (provably unsent), and `running` records are exempt
(recovered by `run_id`, not by re-admission). A missing/unparseable `attempted_at` fails
closed (treated as expired).

## Delivery classification (Section 12)

A write failure on an established Adapter connection (broken pipe / reset / timeout) is
now an **uncertain** terminal `delivery_uncertain` result — never a definitive delete. A
TCP write failure does not prove the Adapter never received the job; deleting and
re-delivering could execute the edit twice. Only "no connection at all" (`findConn`
→ nil) is a definitive non-delivery (`agent_unavailable`, nothing persisted). `DeleteJob`
and `isDeliveryTimeout` are removed (commit `178f5c9`).

## Terminal-result safety (Task 4B.1)

The Relay's `SetJobResult` enforces the terminal-state invariant: a terminal result
(`done`/`error`) is never overwritten by a later non-terminal (`accepted`/`working`)
result. A late activity/`working` update that arrives after the job has settled is ignored
(and logged); a terminal result redelivers idempotently. This closes the last-write-wins
hole a delayed activity update could otherwise exploit.

## Tests

Mock runs backend in `hermes-adapter/runs_test.go` (scripted status sequences, no real
10-minute waits) plus `runstore_test.go`. Covered:

- short run → `done`; long run (repeated `running` then `completed`); run `failed` /
  `interrupted`; malformed output → `hermes_outcome_unparseable`; run not found.
- transient poll error tolerated (backs off, retries).
- idempotent re-admission (same key → same `run_id`).
- `Resume` polls an existing run without re-admitting.
- reconcile of a `running` record (no re-admit) and a `received` record (exactly one
  admit).
- admission state machine (`received → admission_in_flight → running`) and the
  `attempted_at` stamp never being reset on re-mark.
- `admission_in_flight` within grace re-admits; past grace it is marked
  `admission_uncertain` with **no** re-admit.
- `admissionExpired` fails closed on a missing/unparseable timestamp.
- `recoveryGuard` single-flight (claim/deny/release).
- activity mapping (`tool.*`→using_tools, `reasoning.available`→thinking,
  `approval.request`→waiting_for_approval, unknown→working), `pollRunEmit` emission
  (change- or heartbeat-driven, only from successful non-terminal reads, never fabricated
  from a transient error), and the adapter-only "starting"/"verifying" phases
  (`hermes-adapter/activity_test.go`).
- run-store lifecycle and payload round-trip.

`go test ./...` is green; single-annotation back-compat and batch per-annotation
verification are unchanged.

## Known limitations

- **Uncertain admission needs manual review.** An `admission_in_flight` record that
  outlives the 23 h grace is marked `admission_uncertain` (`error`, code
  `admission_uncertain`); the operator must verify whether the edit was applied. This is
  deliberate: it is never silently re-run, and the only way to reach it is an extended
  (> 23 h) Adapter outage mid-admission.
- **Submit-time disconnect (FIXED in Task 4B.1).** `submitRun` now retries an
  UNCERTAIN admission failure (a network error or a 5xx, where the POST may have reached
  Hermes) up to 5 times with bounded backoff (500 ms → 4 s), reusing the SAME
  `Idempotency-Key` and identical payload. A re-POST with the same key returns the
  original `run_id` if the first admission landed, so a submit-time disconnect recovers
  the run rather than failing (or double-executing). A definitive 4xx (e.g. 409
  `idempotency_key_conflict`) fails immediately; a known `run_id` is never re-admitted;
  `attempted_at` is never reset. The 23 h `ADAPTER_ADMISSION_GRACE` still gates
  restart-time re-admission of an `admission_in_flight` record.
- **Activity staleness is honest, not a liveness guarantee.** A long tool call
  produces no new Hermes events, so "last agent activity" can age for minutes while the
  run is still healthy. The UI reports the last observed activity rather than inferring
  a hang.
- **Activity is not durable.** The in-memory SSE backlog expires after 300 s; the
  Adapter's polling signal (`last_event`/`updated_at`) is read live and forwarded only
  while the run is in flight. After a Hermes restart, a recovered run reports activity
  afresh — never replayed history.

## Deployment

Deployed to `ub-host` on 2026-10-15 (Task 4A.2). Actual versions, run-store path,
test-site setup and verified smoke/integration/recovery results are in
`docs/OPERATIONS.md` → *Deployed (2026-10-15, Task 4A.2)*. The branch
`feat/infraverket-emdash` is still **not pushed/merged**. Rollback = restore the backup
(`~/ulla-bella-backup-20261015-212501/`, binaries + config + both DBs) and restart both
services — see the rollback rules in `docs/OPERATIONS.md`.
