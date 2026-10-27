# Ulla-Bella — Job progress & status UX

Plan for Ulla-Bella 2.2.1 — make long agent jobs visible and let the user keep working in
other tabs.

**Implemented (Task 2, 2026-10-15):** the panel progress indicator, toolbar status
badges, and robust alarm-based background monitoring (see *Implemented* at the end). The
sections below describe the design; each notes whether it is implemented or deferred.

## Goals

- The user sees that Hermes is still working (no "did it break?").
- The user can switch tabs and still see activity + completion.
- No invented percentages — an indeterminate indicator is preferred over a fake progress
  bar.

## 1. Panel — animated activity indicator

While a job is in flight, show a compact status block:

```
Hermes is working…
3 annotations submitted
Elapsed: 02:34
Last activity: 12 seconds ago
```

- A small spinner (CSS animation in the content script — do **not** run continuous
  animation in the MV3 service worker).
- Elapsed time since "Send".
- "Last activity" = time since the last status change the extension observed.
- On completion, replace with a clear per-annotation result summary (✓ / ✗ / ?).
  A round with exactly ONE annotation comes back from the adapter with the job-level
  outcome only (per-annotation `annotationResults` is a batch feature), so that one
  annotation takes the job's own verified result — otherwise a verified success
  would read as "result unknown".

## 2. Toolbar icon states (per tab)

Extend the grey/green icon with a badge (via `chrome.action.setBadgeText` /
`setBadgeBackgroundColor` / `setTitle`, keyed by `tabId`):

| State | Indicator |
|---|---|
| Not a connected site | grey U |
| Connected site | green U |
| Hermes working | green U + activity badge |
| Job done | green U + check badge |
| Job failed | green U + error badge |
| Result uncertain | green U + warning badge |

A simple, stable badge is sufficient. `chrome.notifications` can be a later optional
addition.

## 3. Keep working in other tabs

The user should be able to: open infraverket.eu → create annotations → Send all → switch
tab → see progress → get a clear completion signal → return and review.

Requirements:

- Job state must survive a tab switch and a MV3 service-worker restart. Persist the
  in-flight `{jobId, status}` and resume polling on worker start (the extension already
  persists `activeJob` per page and has `resumePoll`; extend it to survive a worker
  restart without a page reload).
- Per-tab badge plus a global "some job is still running" indication.
- Future-proof for Multi-Site / Multi-Agent: state is keyed by Site (and later by agent),
  never a single global flag.

## 4. Real progress signals from Hermes

The Relay/Adapter can report discrete stages rather than raw percentages. A light-weight,
reuse-friendly set of signals:

- Job accepted (Relay)
- Agent connected (Adapter)
- Agent started (Adapter received the job)
- Agent executing tools (Adapter saw Hermes activity)
- Verification in progress
- Job completed / failed
- Connection lost

We do not need a streaming/event bus: these are already derivable from the Adapter's
existing logs and the Relay's job lifecycle. A minimal approach: the Adapter emits a
per-job `status` (e.g. `accepted → working → verifying → done/error`) into the existing
Result/status channel, and the Relay exposes it on `GET /v1/jobs/{jobId}`. The extension
renders "last activity" from the most recent status change.

The key distinction the user needs: **"Hermes is still working"** vs **"no activity for
several minutes"** (which is the signal to surface a problem, not to silently spin).

## Non-goals (this phase)

No percentage progress, no streaming infrastructure, no Multi-Site/Multi-Agent
implementation yet.

---

## Implemented (Task 2, 2026-10-15)

- **Panel progress indicator** — a compact spinner + "Hermes is working…" / "Sending to
  Hermes…" / "Monitoring paused — will resume", with "N annotations submitted",
  "Elapsed: mm:ss" (content-script timer), and "Last checked: Ns ago" (updated by the
  worker's ~5 s heartbeats). No invented percentages.
- **Toolbar status badges** — `chrome.action.setBadgeText` (+ background colour + tooltip):
  working `…`, done `✓`, failed `!`, uncertain `?`. The badge is **global** (visible on
  every tab); per-tab badges are deferred to the Multi-Site work.
- **Robust background monitoring** — each in-flight job is persisted (`jobs` key) with
  `{jobId, status, startedAt, lastChecked, tabId}`; a `chrome.alarms` tick (period 1 min)
  plus a resume on every worker start re-attaches to any non-terminal job, so a MV3 worker
  restart never loses a job. No competing loops (single-flight per jobId).
- **Transient network errors ≠ job failure** — a failed poll marks the job `paused` (and
  stops active polling) rather than failing it; the alarm resumes it. A terminal result is
  only ever a `done`/`error` returned by the Relay.
- **No re-submit** — resume only polls `GET /v1/jobs/{jobId}`; it never re-POSTs, so a
  job is never executed twice.

**Deferred:** per-tab badges; a completion notification; streaming Hermes progress.

### Implemented (Task 4B, 2026-10-16) — real agent activity

The panel now shows a discrete **"Activity: <label>"** line and **"Last agent activity:
Ns ago"**, driven by a real signal from Hermes (not the extension's own guesswork). The
Adapter reads Hermes's run status `last_event`/`updated_at` while polling, maps them to a
controlled vocabulary, and forwards the snapshot on the `working` Result; the Relay stores
it and `GET /v1/jobs/{jobId}` returns it. When no activity has been observed the panel
shows the neutral **"Agent activity unavailable"**; a run that is active but quiet (a long
tool call) shows the *last* observed activity rather than inventing progress. A run
waiting for approval changes the title to "Waiting for approval…". See
`docs/HERMES-ASYNC.md`.
