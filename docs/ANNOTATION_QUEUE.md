# Ulla-Bella 2.2 — Annotation Queue (up to 8 per round)

**Status:** plan approved · **Increments 1–4 complete** (Increment 5 = infraverket verification + icon fix + documentation, this sprint) · **Scope:** Chrome extension + protocol + adapter · **Protocol version:** V1 (unchanged, additive)

---

## 0. Approved decisions (2026-10-15)

1. Test domain is **`infraverket.eu`** (not `.se`).
2. **One Job** with **max 8** annotations.
3. Each annotation gets its own result via **`annotationResults[]`**, keyed by `annotationId`.
4. Job status `done` may contain **both** successful and failed annotations; the result must clearly distinguish them.
5. One annotation round is limited to **a single page** (v1).
6. Discreet, **numbered markers 1–8**, clickable to edit.
7. The queue is **persisted locally** and restorable after reload.
8. Icons renamed **`-blue` → `-active`** (active is now green); all references updated.
9. Keep the clean original graphics in Git; **ignore Dropbox sidecar metadata**.

---

## 1. Goal

Let the user queue **up to 8 annotations** on a page (numbered markers 1–8), edit or
delete them before sending, and submit the whole round as **one Job**. The Result
comes back with **per-annotation** outcomes so partial success is visible per marker.

Primary driver: many small, real edits on infraverket (EmDash) in the near term.

---

## 2. Current state (verified in repo)

- **Protocol already supports it.** `Job.annotations[]` is `minItems: 1` in
  `protocol/job.schema.json`, and `internal/proto/proto.go` defines
  `Job.Annotations []Annotation`. The Relay iterates all annotations
  (`relay/main.go:306`), and the adapter resolves **every** annotation into a
  `ResolvedTarget` (`hermes-adapter/main.go:232-247`). The three executors
  (`mcp.go`, `emdash.go`, `hermes.go`) already branch on `len(ctx.Targets) > 1`.
  → The backend was designed for multi-annotation batches; the **extension**
  currently sends exactly one.
- **Extension is single-shot.** `content.js` `send()` builds one
  `ub.buildAnnotation(...)` → `ub.buildJob({siteId, deviceId}, annotation)` →
  `submitJob` → `background.js` `submitAndPoll` POSTs one job and polls
  `/v1/jobs/{jobId}` for a job-level terminal state.
- **`lib.js` `buildJob(config, annotation)`** hardcodes `annotations: [annotation]`.
- **Result was job-level only** (now extended in Increment 1, below).

---

## 3. Design decisions

| # | Question | Decision |
|---|---|---|
| 1 | One shared job or 8 separate jobs? | **One Job** with `annotations[]` (1–8). Atomic batch, single Relay/agent round-trip, matches the existing schema. |
| 2 | How does Hermes get all annotations? | Adapter forwards the whole `Job` to the executor; the executor builds one prompt enumerating every target (existing `len(Targets) > 1` path). |
| 3 | Correct element coupling? | Reuse existing hints — `selector`, `domPath`, `visibleText`, `rect`. `visibleText` is the durable resolution key (proven for MCP and EmDash); structural hints are advisory. |
| 4 | Partial success reporting? | Add `annotationResults[]` to `Result`, keyed by `annotationId` (see §4). |
| 5 | Prevent double-send? | Persisted `jobId` + per-annotation `annotationId`; a `sending` flag alone is insufficient (see §3.1). |
| 6 | Network break? | Unsent queue lives in `chrome.storage.local`; a failed send leaves it editable for retry. |
| 7 | Preserve an unsent queue? | Persist the queue (per paired origin) on every change; restore on page load / mode re-entry. |

**Batch semantics (approved):** a Job with N annotations is a **shared transport
and execution round, not an atomic transaction**. Each annotation is verified
individually; a failed change does not roll back the others.

**Batch span (approved):** one page per round. Each annotation carries its own
`target.url` and the adapter checks `sameOrigin(origin, url)` — so cross-page
rounds are technically possible, but markers only render on the page where their
element was captured. Deferred.

### 3.1 Idempotency & `jobId` (investigation)

- The Relay keeps `jobs map[string][]byte` (jobId → result envelope bytes) and
  `jobDevices map[string]string` (jobId → owning device) — **in-memory only**
  (`relay/main.go:90-91`), lost on Relay restart.
- `handleCreateJob` does **not** check for an existing `jobId` → **no dedup**.
  Re-POSTing the same jobId is accepted again and forwarded to the adapter a
  second time (double execution).
- The extension generates a **fresh `jobId` on every submission**
  (`lib.js` `buildJob`), so a retry is a genuinely new job — no accidental reuse,
  but also no way to resume a specific accepted round after a reload.
- Result reads are device-scoped (non-owner gets 404).

**Implication for Increment 3:** persist the `jobId` with the queue; reuse it on
an ambiguous retry; add a Relay dedup check (if a `jobId` is already
accepted/working, return the current state instead of re-forwarding). The local
`sending` flag is kept as a UI guard, not as the correctness mechanism.

---

## 4. Protocol change (additive, V1)

Add an optional `annotationResults` array to `Result` (implemented in Increment 1):

```jsonc
// Result gains:
"annotationResults": { "type": "array", "items": { "$ref": "#/$defs/annotationResult" } }

// $defs/annotationResult:
{
  "annotationId": "string",      // maps back to the queue marker
  "status":        "done | error",
  "summary":       "string?",     // short human text for this marker
  "verification":  "Verification?",
  "error":         "Error?"
}
```

**Job-level `status` semantics (approved):**

- `error` — job-level failure: routing, policy (`url_out_of_origin`, `site_*`),
  agent unavailable, or the whole batch could not be processed.
- `done` — the batch was processed; **granular outcome is in
  `annotationResults[]`**. A `done` with some `annotationResults[i].status ===
  "error"` is a partial success.

The transport lifecycle (`accepted → working → done/error`) is unchanged.

**Result contract (approved):**

- **Backward compatible:** a single-annotation job with no per-annotation results
  is unchanged — `annotationResults` is omitted and the job-level
  `summary`/`verification` carry the outcome.
- Each `annotationResult` matches exactly one submitted `annotationId`.
- **Missing / duplicate / unknown IDs** (implemented in
  `normalizeAnnotationResults`, `hermes-adapter/executor.go`):
  - keep the **first** result per `annotationId` (later duplicates dropped);
  - fill a submitted `annotationId` with no result as `status:"error"`,
    `code:"no_result"`;
  - drop results whose `annotationId` was not part of the submitted Job;
  - emit in job order, exactly one entry per submitted `annotationId`.

**Schema:** `done` now requires either (`verification.status === "passed"` +
`summary`) *or* `annotationResults[]` — strictly more permissive than before, so
single-annotation jobs are unaffected.

---

## 5. Changes by component

### 5.1 `protocol/result.schema.json` — **done (Increment 1)**
Added `annotationResults` + `$defs.annotationResult`; relaxed the `done` `allOf`
to accept the batch path.

### 5.2 `internal/proto/proto.go` — **done (Increment 1)**
Added `AnnotationResult` struct and `Result.AnnotationResults []AnnotationResult`.

### 5.3 Relay
Pass-through only. It already validates Results against `result.schema.json`
(`relay/main.go:440`) — the updated schema must be deployed with the Relay
before the adapter emits `annotationResults` (Increment 2). No routing change:
it already routes the whole Job by `siteId`.

### 5.4 Adapter + executors (`hermes-adapter/`) — **plumbing done (Increment 1)**
- `Outcome` now carries `[]AnnotationResult`; `handleJob` normalizes them against
  the submitted annotations (`normalizeAnnotationResults`); `outcomeToResult`
  maps them into `Result.AnnotationResults`.
- **Increment 2 (done):** `mcp.go`, `emdash.go`, `hermes.go` produce one outcome
  per `ResolvedTarget`; Hermes returns a structured `{"results":[…]}` batch; each
  "done" annotation is re-checked by its mode-specific deterministic postcondition
  before it is accepted. See `docs/ARCHITECTURE.md` §3.7 for the partial-success
  contract.

### 5.5 Extension — `lib.js` (Increment 3)
Change `buildJob(config, annotations)` to accept an array; `buildAnnotation`
unchanged.

### 5.6 Extension — `content.js` (the bulk, Increment 3)
- Replace single `selectedTarget`/`selectedElement` with a queue of
  `{ annotationId, instruction, target, element }` (max 8).
- Numbered markers 1–8 (`.ullabella-ui` namespaced badges), repositioned on
  scroll/resize, re-anchored on DOM mutation (`selector`/`domPath` re-query,
  `visibleText` fallback); surface a moved/removed element instead of dropping it.
- Panel becomes a queue editor: add, list 1–8, edit, delete, `n / 8` indicator,
  one **Send** posting a single Job.
- Persist the queue in `chrome.storage.local` (keyed by origin); restore + re-anchor
  on load; per-marker ✓/✗ rendering from `annotationResults[]`.
  **Superseded by [`docs/SESSIONS.md`](SESSIONS.md):** the queue is now one *session
  document* per connected site + page (`ub.session.<siteId>|<pageId>`), with tombstones and
  merge-on-write; the old per-origin `queues` entry is imported once and kept.

### 5.7 Extension — `background.js` (Increment 3)
`submitAndPoll` already forwards `msg.job` verbatim — add forwarding of
`annotationResults` through `notifyStatus` on `done`.

### 5.8 Extension — `popup.js`
No functional change. Icon naming handled in this task (§0.8).

---

## 6. Rollout increments

1. **Protocol + types** — `result.schema.json`, `proto.go`, `AnnotationResult`,
   adapter `Outcome` plumbing. **✅ done.**
2. **Adapter per-annotation outcomes** — executors + Hermes structured batch
   prompt; Go tests. **✅ done.**
3. **Extension queue** — queue model, markers, `n/8`, edit/delete, persistence,
   batch send, idempotency + Relay dedup. **✅ done.**
4. **Per-marker results** — consume `annotationResults[]` in the panel. **✅ done.**
5. **Real infraverket click-through** — manual Chrome E2E on `infraverket.eu`,
   plus the browser-free server-side E2E for CI. **In progress** (this sprint:
   icon fix, Chrome verification, documentation).

---

## 7. Acceptance criteria

- Queue up to 8; `n / 8` indicator; add / edit / delete; a 9th is blocked until send
  or delete.
- "Send" submits **one** Job with N annotations; Relay and adapter accept it with
  no schema error.
- Result carries `annotationResults[]` keyed by `annotationId`; partial success is
  reported per marker, not as one opaque error.
- Unsent queue survives reload and network interruption; a double-send is
  impossible; a failed round leaves the queue intact for retry.
- Markers follow their element on scroll and survive reasonable DOM changes; a
  removed element is surfaced, not lost.
- Tests: Node unit tests (`lib.js` array job, content queue logic), Go tests
  (Outcome → `annotationResults` mapping + normalization — added in Increment 1),
  and the browser-free E2E posting a 3-annotation job.

---

## 8. Risks & dependencies

- **Hermes structured batch parse** — the adapter must reliably read a
  per-annotation JSON outcome; mitigate with a strict schema and a
  single-annotation fallback.
- **DOM anchoring is inherently best-effort** (SPAs, dynamic render) — re-anchor by
  `selector`/`domPath` then `visibleText`, and surface "element gone".
- **EmDash batch = N content edits** — each verified individually; a single bad
  annotation must not roll back the others.
- **Relay keepalive drop** (not fixed here): the Relay drops idle adapter WS
  connections ~every 2 min; the extension already retries `agent_unavailable`.
- **Toolbar icon** (resolved in Increment 5): `chrome.action.setIcon({path})` rejected
  the runtime-only `-active` PNGs; fixed by preloading the icons into `ImageData` and
  calling `setIcon({imageData})` (commit `15be925`).
- **Relay schema deployment:** the running Relay on the VM still has the pre-Increment-1
  `result.schema.json`; it must be redeployed (with the adapter) before the adapter
  emits `annotationResults` in Increment 2.

---

## 9. Resolved / deferred

- **Resolved:** domain (`infraverket.eu`), single Job (max 8), per-annotation
  results, single-page round, clickable numbered markers, local queue persistence,
  icon rename (`-active`).
- **Deferred:** cross-page rounds; new `partial` status enum (chose `done` +
  `annotationResults[]`); marker visual design (Google-Docs bubble vs inline chip
  — small design pass reusing `annotate.css`); `maxItems: 8` guard in
  `job.schema.json` (add with Increment 3).
