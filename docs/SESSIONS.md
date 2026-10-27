# Ulla-Bella — sessions

**Status: etapp 1 and etapp 2 implemented (extension `0.1.0`; Protocol V1 extended
additively — see §9). Etapp 3 planned.**
This document is the authority for the session model. It records the target flow, the
verified root cause of the "removed annotations come back" bug, the etapp-1
implementation, the etapp-2 session UX and job context, their verification, and the plan
for etapp 3.

---

## 1. Target flow (the whole picture)

An **editing session** is one page of one connected site, worked on with one agent:

1. **Start editing** opens the session description first — the question *"What do you want
   to do this time?"* — and the user describes the purpose of the session.
2. The user then adds individual annotations (numbered markers) on the page.
3. The description stays readable and editable during the session and is sent as shared
   job-wide context together with the annotations.
4. Clicking a numbered marker opens a small panel at the marker showing the annotation's
   **full instruction**. It closes with a close button, `Escape`, or a click outside, works
   with the keyboard, and stays inside the viewport.
5. Settings show the connected site and the Hermes agent. One extension can hold several
   sites and several agent connections without mixing instructions, queues or results.
6. **Clear session** clears exactly one session (its annotations and its description) and
   never touches other sites' sessions or the connection settings.

Split into three stages:

| Stage | Scope | State |
|---|---|---|
| **1** | Durable deletion + session foundation: session identity, tombstones, merge-on-write, single writer, per-site isolation, "Clear session", migration of the old queue state, submitted-round snapshot. | done |
| **2** | The session UX: session description on start (with skip), description read/edit in the panel, job-wide context through to the Hermes prompt, marker comment popover with keyboard support, visible save status. | done |
| **3** | Multi-site/multi-agent settings: site switcher, agent per site, per-site session list, switching without re-pairing. | planned |

The UI copy is English, matching the rest of the extension ("Start editing", "Send all",
"Clear session"); the sessionsbeskrivning step is therefore *Session description* /
*"What do you want to do this time?"*, not the Swedish wording from the brief.

---

## 2. Verified root cause of "old annotations come back"

Symptom: annotations several days old reappear after being removed with ×; the page shows
the old markers and the panel the old queue rows.

The extension stored its queue as **one entry per page** under a single storage key:

```js
// before etapp 1 (content.js)
queues[pageId(location.href)] = { annotations: serialize(queue), job: activeJob }
```

`persist()` read the whole `queues` map, replaced its own page key and wrote the **whole
map** back. There was no session identity, no deletion record, no write serialization and
no cross-tab convergence. Three consequences, two of them reproduced in tests:

1. **Last writer wins, so a deletion can be undone.** Any other live context that still
   holds the old queue (a second tab receiving a late `ubJobStatus`, or simply the next
   write in a stale tab) writes its own stale snapshot over the newer one. The removed
   annotation is back, with the same id — so it also looks "days old".
   *Reproduced:* two tabs, both show 2 annotations; tab A removes both; a late `done`
   status reaches tab B → tab B persists its stale queue → a reload shows both annotations
   again.
2. **The whole-map read-modify-write resurrects deletions on other pages.** A write for
   page A re-writes its stale copy of page B's entry.
   *Reproduced:* page B removes its annotation, page A keeps working → page B's annotation
   returns after reload.
3. **No session boundary at all.** `restore()` adopts whatever is stored for the page,
   indefinitely. Nothing distinguishes "my current work" from "a queue from last week", so
   once an entry is resurrected it stays, and the only way out was *Start new round* —
   which only appears after a round reaches a terminal state.

Deleting also had no relation to the submitted round: the panel could not tell the
difference between *removing an annotation from my queue* and *cancelling work already sent*.

The fix is the session model below: **deletion is a first-class, permanent fact
(tombstone), and every write is a merge that tombstones always win.**

---

## 3. The session model

Pure module `extension/src/session.js` (UMD, no DOM, no `chrome.*`, unit-tested).

```
ub.session.<siteId>|<pageId>   → one session document per site + page
queues                          → pre-2.2 storage, read once, never destroyed
ub.migrated.legacy              → { <sessionKey>: timestamp } marks an imported legacy entry
```

```jsonc
{
  "version": 2,
  "sessionId": "ses_…",        // identity of THIS session; a cleared session gets a new one
  "lineageId": "lin_…",        // stable for the storage slot, survives every clear
  "generation": 0,             // how many times this slot has been cleared
  "siteId": "site_infraverket", // isolation boundary part 1
  "siteName": "infraverket.eu",
  "pageId": "https://infraverket.eu/",  // isolation boundary part 2 (query/hash rules
  "pageUrl": "https://infraverket.eu/", // from queue.js pageId)
  "description": "",            // "Vad vill du göra den här gången?" (etapp 2 UI)
  "descriptionUpdatedAt": null,
  "annotations": [              // serializable only — live DOM nodes live in content.js
    { "annotationId": "ann_…", "instruction": "…", "target": {…},
      "result": { "status": "done", "summary": "…" },
      "createdAt": "…", "updatedAt": "…" }
  ],
  "job": {                      // the round that was submitted from this session
    "jobId": "job_…", "status": "sending|working|done|error|uncertain",
    "siteId": "…", "origin": "…", "relayUrl": "…", "agentId": null,
    "sessionKey": "…", "submittedAt": "…", "annotationIds": ["ann_…"]
  },
  "deleted": { "ann_…": "2026-10-26T…" },  // tombstones — permanent for the session
  "rev": 7,                     // monotonic revision of persisted state
  "createdAt": "…", "updatedAt": "…", "clearedAt": null,
  "previousSessionId": null,    // informational: what this session replaced
  "legacy": { "migratedAt": "…", "annotations": 2 }
}
```

Invariants:

1. **A session never spans two sites.** The storage key contains `siteId`; a site change
   (re-pairing) cannot read another site's queue, even on the same origin and path.
2. **A removal is a tombstone.** `removeAnnotation()` drops the annotation *and* records
   `deleted[annotationId]`; `clearSession()` clears the document. Nothing ever removes a
   tombstone except creating a new session.
3. **Every write is a merge, and it happens in exactly ONE place.** The service worker owns
   every session write (`src/session-writer.js`, message `writeSession`); it serializes
   read → merge → write per storage key, so two tabs can never interleave a read with each
   other's write. `mergeWrite(stored, local)` unions the tombstones, keeps the union of the
   annotations (minus tombstones), prefers the newer copy of a shared id, the newer
   description, and the newer/terminal job. A stale document can therefore never resurrect a
   deletion, never un-finish a finished round, and never silently drop another tab's work.
   See *Write path* below for the restart argument.
4. **One lineage per slot, and a monotonic generation.** `clear()` keeps `lineageId`, gives
   the session a new `sessionId`, and increments `generation`. A write is accepted only if it
   comes from the same lineage at the current generation (merge), from a LATER generation (the
   caller cleared: it replaces the slot), or from another lineage that is also at generation 0
   (genuinely concurrent first creation of an empty slot, where nothing can be resurrected
   because nothing was ever deleted). Everything else is refused and the stored document is
   adopted. This needs no history: two integers decide it, so any number of clears stays safe.
5. **Results are matched by `annotationId`, never by position.** A result for a tombstoned
   annotation is simply discarded; the remaining annotations keep their own results.
6. **A submitted round is pinned.** `job` carries the `siteId`, `origin`, `relayUrl` and
   `sessionKey` it was submitted with (the service worker additionally snapshots the
   device credential per job), so later setting changes cannot re-route it or deliver its
   result into another session. `agentId` is reserved for etapp 3.

### Write path and service-worker restarts

```
content script (tab)              service worker                     chrome.storage.local
  persist(session)  ──message──▶  session-writer queue[key]
                                    read(key) ───────────────────▶   get
                                    session.mergeWrite(stored, local)
                                    write(key, merged) ──────────▶   set
  applySession(stored ◀──reply──   (merged document)                   │
  chrome.storage.onChanged ◀───────────────────────────────────────  onChanged
```

* **Two tabs writing at once**: both messages land in the same queue for that key, so their
  read-merge-writes are strictly ordered. The second one reads what the first wrote.
* **Two different sessions**: different queue keys, so they never block each other.
* **Worker killed mid-message (MV3)**: the queue is in-memory but holds nothing that matters —
  all state is in storage. A kill before the `set` leaves the store untouched and the content
  script retries (3 attempts, 40/80 ms apart); a kill after the `set` means the retry merges
  an already-applied change, which is idempotent. A document whose write was never
  acknowledged is kept and re-sent on the next `enter()`/`persist()`.
* The `ub.migrated.legacy` marker is written by the worker in the SAME `set` call as the
  imported session.

### Migration (no silent data loss)

On the first `restore()` for a page, if no session exists and a legacy
`queues[pageId]` entry is present:

* the entry is imported with its **original annotation ids and results** (so results keep
  matching), gets a fresh `sessionId`, and
* `ub.migrated.legacy[sessionKey]` is written in the **same** `chrome.storage.local.set`
  call.

The legacy `queues` key is **kept, never deleted**, and a page is imported at most once —
a re-import would resurrect annotations the user has since removed. Clearing a session only
clears its session document; legacy data stays untouched.

---

## 4. Etapp 1 — what changed

### Extension (`extension/src/`)

* **`session.js` (new)** — the model above: `normalize`, `fromLegacy`, `withAnnotations`,
  `withInstruction`, `withJob`, `withDescription`, `tombstone`, `removeAnnotation`,
  `clear`, `mergeWrite`, `reconcile`, `storageKey`, plus `lineageId`/`generation`.
* **`session-writer.js` (new)** — the single writer: one serialized read → merge → write queue
  per session key, used by the service worker only (see *Write path* above).
* **`content.js`** — the queue is no longer a local array: the session document is the
  single source of truth (`session.annotations`, `session.job`). Live DOM nodes moved to a
  separate `anchors` map, so nothing DOM-bound is ever persisted. `restore()` and `persist()`
  are serialized in the tab, and **the tab never writes the document itself**: `persist()`
  sends it to the worker (`writeSession`), retries a transport failure, adopts the merged
  document the worker returns, and `chrome.storage.onChanged` adopts other tabs'
  tombstones/additions.
  * × now removes one annotation from *this* session's queue, markers and stored state.
  * **Clear session** (header, always available): first click arms and names the session
    (`Example Test · /tjanster`), second click clears annotations + description. `Start new
    round` is gone — it was terminal-only and could not clear a stuck queue.
  * Deleting/clearing during a running round is honest: *"the request already sent keeps
    running — removing it here does not cancel it"* / *"its result will be discarded"*.
  * `onStatus` ignores a status whose `sessionKey` or `jobId` is not this session's current
    round, and applies results only to live annotations.
  * The session label names the site and page path; the Clear button's tooltip/aria-label
    carry the same identity.
* **`background.js`** — owns `sessionWriter` and the `writeSession` message (the only write
  path); each job record snapshot `{relayUrl, deviceCredential, sessionKey, siteId}`; status
  messages carry `jobId` + `sessionKey`; `resumeActiveJobs`/`resumePoll` poll with the
  *record's* relay and credential, not the current pairing.
* **`annotate.css`** — session row + Clear button styles; dead `.ullabella-reload` removed.
* **`scripts/package-extension.sh`** — `src/session.js` + `src/session-writer.js` added to the
  copy list and to the required-file check.

### Behaviour changes a user will notice

* Removing an annotation is final — after reload, panel reopen, service-worker restart or a
  late result, it stays removed.
* Two tabs on the same page stay in sync: a deletion in one disappears in the other.
* A second connected site gets its own queue; nothing leaks between sites.
* The panel names the session it is about to clear.
* Removing an annotation during a round no longer pretends the round was cancelled.
* The old queue is imported once on first use, with its results.

Protocol V1 is **unchanged**. Relay and adapter are **not** part of etapp 1.

---

## 5. Verification

Automated (`node --test`, 116 tests, all green):

| File | What it proves |
|---|---|
| `test/session-model.test.js` (14) | key isolation per site/page, normalize/tombstone rules, merge-on-write (stale writer, cross-tab additions, newer edit, cleared slot, successor, sibling creation), clear semantics, legacy import, reconcile, job precedence. |
| `test/session-writer.test.js` (5) | the single writer: per-key serialization (a stale document submitted second cannot win), independent keys do not block, a failing write does not wedge the queue, a fresh instance after a worker restart still merges with the store, invalid input is rejected. |
| `test/session-concurrency.test.js` (11) | the reviewed defects: both write orders with **both tabs reading before either writes**, deletion + addition + status update in flight, a clear against a concurrent old write, two clears followed by a write from the original generation, a never-notified (truly stale) tab, a tab that adopted the clear (may keep working), concurrent first creation of an empty slot, a deletion acknowledged before a **worker restart**, and an unresponsive worker whose write is retried. Every case asserts the **stored** document and then a freshly opened tab. |
| `test/queue-persistence.test.js` (3) | the original bug shapes (late status, cross-page) end to end. |
| `test/session-lifecycle.test.js` (8) | removal survives reload/late status/second tab, cross-tab convergence without reload, Clear session scope + naming + description + other pages untouched, honest running-round messages, late result after clear discarded, foreign `jobId` ignored, two-site isolation, legacy migration once and still deletable, `annotationId`↔result matching after a mid-round deletion. |
| `test/background-monitor.test.js` (5) | job monitoring unchanged, plus the worker's real `writeSession` handler: merge, persistence, and a stale document that cannot undo a deletion. |
| `test/status-path.test.js`, `content-click.test.js`, `lib/queue/monitor/pair/relay-policy/manifest` (74) | unchanged behaviour of the existing flows (send → done, activity line, id reuse, permissions). |

Regression tests were proven to bite twice:

* **Against the reviewed commit `7c51c40`** (a detached worktree with the new tests copied
  in; the harness reaches the store without the writer module): 8 of the 11 concurrency tests
  fail, for the reported reasons — *"the deleted annotation must not be stored again"*
  (delete-first: `ann_old` back), the addition lost in the other write order, three
  annotations after a status update, a cleared session undone, `write: true` for a pre-clear
  view (twice), and a lost first annotation on concurrent creation. The other 5 either need
  the interleaving they already guard (restart/unresponsive) or assert behaviour that holds
  in both versions (a tab that adopted the clear).
* **By mutation** in the fixed tree: tombstones not authoritative (4 failures), ownership
  guard removed (1), `removeAnnotation` not tombstoning (9).

Manual Chrome checks **not** performed in this environment (no scripted Chrome here):
the visual panel layout of the new session row, the real two-tab behaviour, and a real
round against the VM stack. Checklist for the review:

1. Load the unpacked extension (`C:\ulla-bella-extension`, Reload — never
   Remove), open the paired site twice.
2. Add 2 annotations in tab A, remove one, reload → 1 marker, 1 row.
3. With both tabs in editing mode, remove the last annotation in tab A → tab B loses it
   too without a reload.
4. Click **Clear session** → it names the site and path, a second click empties the queue.
5. Send a round, then remove an annotation while it is working → the message says the
   round keeps running; when it finishes, the removed annotation does not return.

---

## 6. Known limits

* **A genuinely stale tab loses its write.** If a tab never received the storage event for a
  clear (a dropped listener, a suspended tab) and then adds an annotation, the write is
  refused and the cleared document is adopted — the new annotation in that tab is discarded.
  This is the deliberate price of "a cleared session can never be undone"; a tab that *did*
  receive the clear keeps working normally. Since etapp 2 the user is told, sees the text,
  and can add it back explicitly (§8).
* **Writes need the service worker.** If the worker cannot be reached at all, the change
  stays in memory and is retried on the next `persist()`/`enter()`; it is never written by
  the tab itself (that is what caused the lost deletions). Since etapp 2 this is visible in
  the panel with a Retry.
* **No cancel.** Hermes exposes `POST /v1/runs/{run_id}/stop`, but the extension has no path
  to it; deleting/clearing only *says* the round keeps running.
* **`pairedSite` is memoized per page load**: re-pairing the browser requires a reload
  before the old tab uses the new site (etapp 3 site switcher).
* **Tombstones accumulate** per session (one small entry per removed annotation, dropped
  when the session is cleared). They are what makes deletion permanent; keeping them is
  deliberate.
* **`restore()` still adopts the stored session on every entry** — sessions do not expire.
* The legacy `queues` key is kept forever (documented above). A later cleanup may delete it
  once no pre-2.2 extension is in use.
* **The description is capped at 2000 characters** in the extension (`maxlength`) and in the
  schema, and is stored/forwarded verbatim (never interpreted as markup).

---

## 7. Etapp 2 — session UX and job-wide context (implemented)

### 7.1 The first step

`enter()` calls `maybeShowIntro()` after restoring the session:

| Session state | What happens |
|---|---|
| `intro === null`, no annotations | the *Session description* card is shown |
| `intro === null`, annotations present | no card; the session is marked `intro: "existing"` (a pre-etapp-2 session continues without a blocking step) |
| `intro === "completed" \| "skipped" \| "existing"` | no card, ever again for this session |
| after **Clear session** | `intro` is reset to `null`, so the next round asks again |

The card is a `role="dialog"` with the title **Session description**, the question **"What
do you want to do this time?"**, the help line *"Describe the purpose and anything that
applies to every change. Then mark the details on the page."*, a textarea (max 2000) and two
buttons: **Start annotating** and **Skip**.

* **Start annotating** saves the text and records `intro: "completed"`.
* **Skip** records `intro: "skipped"`. If the user typed something before skipping, that
  text is saved anyway — typed text is never discarded silently.
* Starting to annotate while the card is open (clicking a page element) records a skip and
  continues, so the step never blocks.
* `Escape` skips; exiting annotation mode closes the card without recording anything (the
  step is offered again next time, which is correct: nothing was decided).

The step is stored as `intro`/`introAt` in the session document and written through the
etapp-1 single writer; `mergeWrite` lets a set state beat "not answered" and the later of two
answers win, so an old tab or an empty description cannot make the question come back.

### 7.2 The description in the panel

A row under the session label shows the description (or *"No session description yet."*)
with **Add description / Edit description**; editing is an inline textarea with Save/Cancel,
persisted through `sessionMod.withDescription()`. Long text is clamped with its own scroll
area.

### 7.3 Job-wide context, all the way to the prompt

* `lib.buildJob(config, annotations, { session })` adds `context: { session }` **only when
  the description is non-empty** — a job without a description is byte-identical to before.
* `protocol/job.schema.json`: optional, closed `context` object with `session` (string,
  maxLength 2000). The Relay validates every Job payload at ingest, so an older Relay
  rejects the new field (`invalid_job`) — deploying the schema (and the adapter) is part of
  the release, see §7.5.
* `internal/proto.Job` gained `Context *JobContext`.
* The adapter's three prompt builders (filesystem, YOOTHEME MCP, EmDash) all call
  `writeSessionContext()` **once**, before the annotations:

```
Session description (what the user is doing on this page overall — shared context for
every annotation below; it is not a task of its own and must not be repeated per annotation):
<the user's text>

Annotations (one task each, identified by their stable annotationId):

Task 1 (annotationId: ann_…)
...
```

A single-annotation prompt now also names its `annotationId` (`Annotation (annotationId:
…)`), because that id is what the per-annotation result is keyed by. The description is
never turned into an annotation and never repeated per annotation.

The submitted round snapshots what was sent (`job.sessionDescription`); later edits change
the session (and the next submission) only.

### 7.4 The marker comment popover

* Every marker is a `role="button"` with `tabindex="0"`, an `aria-label` (`Annotation N:
<instruction>`), `aria-haspopup="dialog"` and `aria-expanded`.
* Click or `Enter`/`Space` opens one popover at the marker with the number and the full
  instruction (plus the result line when there is one). `×`, `Escape` or a click outside
  closes it; opening another moves it; only one is ever open. Focus moves to the close
  button and returns to the marker on close.
* The popover is `position: fixed`, placed below the marker, flipped above when there is no
  room and clamped to the viewport on all sides (8 px padding); it is repositioned on scroll
  and on a window resize (which is also what a browser-zoom change produces), and closed if
  the marker disappears. **The whole panel is capped at the available height** (`max-height`
  inline + CSS, head and actions pinned, body scrolling with `flex: 1 1 auto; min-height: 0`),
  so a long instruction on a short window can never push the close button or "Edit in panel"
  off-screen; long instructions scroll inside the body (240 px on a tall window).
* Marker clicks are our own UI, so the capture-phase click handler never treats them as a
  page selection; an outside click while a comment is open only dismisses the comment.
* User text is written with `textContent` — markup in an instruction can never become HTML.
* Removing an annotation or clearing the session closes its popover.
* **Edit in panel** inside the popover keeps the old shortcut: the panel is still where
  annotations are edited.

### 7.5 Visible save status

| Situation | What the user sees |
|---|---|
| write acknowledged | nothing (the panel just shows the new state) |
| write never acknowledged (worker killed mid-message, all retries failed) | amber bar: *"This change is not saved yet."* + **Retry**; the change stays in memory and is re-sent on the next persist/enter |
| write refused because another tab cleared the session | red bar: *"This session was cleared in another tab, so your session description and N annotations here were not saved. Nothing is put back automatically."*, the affected instructions **and the description** as selectable text, **Add them back** and **Dismiss** |

The refused text is read from **the snapshot that was sent** (`sent`), not from the local
session, so the right user text is kept even if the tab has moved on in the meantime.
Together the bar reports both halves of the refusal: annotations *and* the session
description, so a description typed into a tab whose session was cleared elsewhere is never
silently replaced by an empty one.

**Add them back** is the only way refused annotations or a refused description return: it
writes the user's own text into the current session. Nothing is ever restored automatically.

### 7.6 Verification (etapp 2)

Automated: **143** extension tests (`node --test`, 22 in `test/session-etapp2.test.js` plus the
**5** correction-pass tests in `test/session-etapp2-fixes.test.js`) and the Go suites (**7**
tests in `hermes-adapter/session_context_test.go` and `relay/session_context_test.go`).

| Area | Covered by |
|---|---|
| first step: shown, exact copy, Start/Skip, no re-ask, empty description, existing session, auto-skip on annotate, reset by Clear | `session-etapp2.test.js` (7 tests) |
| description read/edit, survives reload, isolated per page/site | `session-etapp2.test.js` (2) |
| job context: present with a description, absent without, not duplicated per annotation, submitted round keeps its own text, older session still works | `session-etapp2.test.js` (4) |
| prompt text in all three modes, old jobs unchanged, blank description, single-annotation id, protocol JSON | `hermes-adapter/session_context_test.go` (5) |
| schema accepts `context`, rejects anything else | `relay/session_context_test.go` (2) |
| popover: open, one at a time, switch, ×/Escape/outside, keyboard, attrs, no page selection, long text, HTML-safe, delete/clear closes, viewport clamping | `session-etapp2.test.js` (7) |
| save status: unsaved + Retry, refusal explained + explicit re-add | `session-etapp2.test.js` (2) |
| correction pass: refused **description** (alone and with annotations) kept, explained, re-addable; unsaved text in an open description editor survives a remote update; popover height cap; re-fit on resize | `session-etapp2-fixes.test.js` (5; 4 of them fail before the fix) |
| etapp-1 regressions (deletion, tombstones, concurrency, worker restart) | the 116 tests from etapp 1, unchanged and green |

Real-browser geometry (Chromium 145, the extension loaded unpacked against a local fixture
page, 1.4k-character instruction, a done result row, viewport **484×209** and again at
**150 % zoom**):

| | popover top | popover bottom | viewport bottom − 8 | overhang | `max-height` | body scroll |
|---|---|---|---|---|---|---|
| before the fix, 484×209 | 37 | 395 | 201 | **+194 px** | none | 240 / 1091 |
| after the fix, 484×209 | 8 | 201 | 201 | 0 | 193 px | 75 / 1091 |
| after the fix, 150 % zoom (323×273) | 8 | 265 | 265 | 0 | 257 px | 140 / 1092 |

In all three the close button and "Edit in panel" stayed inside the viewport; the body
scrolled to the end of the instruction. These are measured `getBoundingClientRect()` values
from the real layout engine, not mock numbers.

Live verification against the running stack (VM `ub-host`), isolated filesystem test
site `site_fs_test2`:

1. Deployed: relay restarted with the new `job.schema.json` (verified: `/healthz` 200,
   `/readyz` 200), adapter `0.13.0` (commit `a5d262a`) started and registered.
2. A browser-free client was paired and posted a job **with** `context.session`:
   `accepted → working (working → using_tools) → done`, H1 changed to "Session Context
   Verified".
3. The **actual prompt** Hermes received (read from `~/.hermes/state.db`, read-only) begins
   with the session-description section, then `Annotation (annotationId: …)` with target and
   requested change; the description occurs exactly once.
4. A second job **without** `context` (the pre-etapp-2 payload shape) was accepted and
   executed the same way.
5. The test site's H1 was restored afterwards (the site is a fixture).

Not verified here: the same flows in the user's own Chrome. The geometry above comes from a
headless Chromium 145 with this extension loaded unpacked; the visual appearance on a real
page and the click-through in the user's browser are still on the checklist in §7.7.

### 7.7 Manual checklist (real Chrome)

1. `chrome://extensions` → Reload (`↻`, never Remove) the unpacked
   `C:\ulla-bella-extension`; open the paired site.
2. **Start editing** → the *Session description* card: title, question and help line; write
   a sentence → **Start annotating** → the panel opens with the description.
3. Reload the page, start editing again → no card. Clear session → the card returns.
4. Add two annotations, click a marker → the popover at the marker; `Tab` reaches markers,
   `Enter`/`Space` opens, `Escape`/×/outside closes, focus returns to the marker.
5. Send the round; open the popover during and after it → the result line appears; long
   instructions scroll inside the popover.
6. Two tabs: clear in one, then add in the other → the red save bar with the text and
   **Add them back**.
7. Send a round with a description against the test site and watch Hermes change the page.

---

## 8. Etapp 3 — several sites and a chosen Hermes agent (implemented)

### 8.1 How a Job actually reaches a Hermes agent (surveyed before coding)

```
tab (origin)  ->  connection (<relay origin>|<siteId>)  ->  POST /v1/jobs {siteId, agentId?}
   -> Relay: pickConn(siteId, agentId)  ->  the adapter socket for THAT agentId
      -> adapter process: agent.id, hermes.base_url + model + api_key_env, site tool (workspace)
         -> Hermes changes the workspace file  ->  result{annotationId, status, summary}
```

Four different things carry the word "agent", so they are named apart here:

| Layer | Identifier | Decides |
|---|---|---|
| Extension | `connection.agentId` (a preference, sent as `payload.agentId`) | which adapter the Relay must use |
| Relay | `agents.agent_id` + `agent_sites` grant | authorization and the live socket to deliver to |
| Adapter | `agent.id` (its own credential) | which process/credential claims the job |
| Adapter → Hermes | `hermes.base_url`, `model`, `api_key_env`, per-site `tool` | **which Hermes instance edits what** |

The popup's agent name is therefore only a label for `agentId`; the choice is real because
the Relay delivers to exactly that adapter, and each adapter decides its own Hermes endpoint
and workspace. With one Hermes instance two agents are still distinguishable by workspace
(verified live in §8.7).

### 8.2 Connection identity and session keys

* A connection id is `<relay origin>|<siteId>` (`connections.js` normalizes the relay origin
  and strips a trailing slash). Different relays hosting the same `siteId` are different
  connections — separate credentials, separate sessions, separate jobs.
* Session storage: `ub.session.<connectionId>|<pageId>` (was `ub.session.<siteId>|<pageId>`).
  One key = one page in one connection; the etapp-1 writer's queue is per key, so the
  concurrency guarantees are unchanged and now scoped per connection.
* A submitted round stores `job.connectionId`, `job.relayUrl`, `job.agentId`,
  `job.sessionDescription` and its own credential snapshot; polling uses that snapshot, so a
  later settings change cannot re-route an accepted job, a resend or a resumed monitor.

### 8.3 Migration from the single pairing (idempotent, no silent loss)

* `migrate()` is pure: legacy `site` → one connection with a deterministic id
  (`migratedFrom: "site"`). Running it twice produces the same id and no duplicate.
* The marker `ub.migrated.connections` is written **only when there was something to
  migrate**. A brand-new profile writes no marker, so a legacy record appearing later (an
  older profile, a downgrade) is still imported.
* `removedConnections` is a tombstone: a disconnected connection is never resurrected by a
  re-run of the migration.
* A session saved under the old siteId-only key is imported once, and only for the
  connection that came from the single-pairing migration (`ub.migrated.sessions` marks it).
  `sessionId`, queue, tombstones, description and intro status are kept; the import goes
  through the etapp-1 writer, so a second tab importing concurrently cannot double-add. A
  second relay with the same `siteId` does **not** inherit that session.
* Nothing is deleted: the legacy records are left in place and simply become unreferenced.

### 8.4 Which connection a tab uses

* `resolveForOrigin()`: no match → not connected; one match → used; several → the stored
  per-origin choice if it is still valid, otherwise editing is refused (the user must
  choose). The popup shows the chooser whenever an origin has more than one connection —
  also when a choice already exists — so switching is explicit rather than "whatever was
  chosen first". The no-choice wording ("connected more than once") is distinct from
  "not connected".
* Importing another connection never repoints an origin that already has one.
* Open tabs re-resolve on `chrome.storage.onChanged` (connections and per-origin choice):
  the panel, markers and queue switch to the other connection without a reload. Unsaved
  text in an open editor is preserved; a round already submitted keeps its snapshot.

### 8.5 Settings view

Entry: **Settings** in the popup. Per connection: site name, origin, the relay host **only
when it is needed to tell connections apart** (same `siteId` on two relays), the agent
picker, a verified status, and a two-click **Disconnect**.

* Status comes from a real probe (`listAgents` through the service worker): **Connected**,
  **Site unreachable** (network/timeout), **Not authorized** (credential rejected), **Status
  unknown** (no probe yet). Unreachable and unknown are deliberately different strings: only
  the first is evidence of a problem.
* The agent list comes from `GET /v1/sites/{siteId}/agents` — only agents granted to that
  site, with a live `connected` flag. A previously chosen agent that the relay no longer
  offers stays visible ("no longer offered") instead of silently disappearing.
* Disconnect removes one connection and its per-origin choice; local sessions, the other
  connections and the agent preferences of those connections are untouched. Clearing a
  session remains a separate action in the editor.
* The current site and agent are shown next to **Start editing** and in the editing panel.

### 8.6 Server changes and compatibility

* `payload.agentId` is optional (closed schema, `maxLength: 128`). Absent → the etapp-1/2
  behaviour: the Relay picks the first connected agent granted for the site (documented, not
  silent).
* `pickConn()` with an `agentId` never falls back: not granted → `403 agent_not_allowed`,
  granted but not connected → `503 agent_unavailable`. The client shows the relay's message
  instead of pretending a run happened.
* `GET /v1/sites/{siteId}/agents` is device-authenticated and returns flat JSON outside
  Protocol V1 (like `/v1/pair`): `{siteId, agents:[{agentId, name, connected}]}`. It lists
  only agents granted to that site, so it cannot be used to enumerate the installation.
* Install order: relay binary + `job.schema.json` **first**, then the extension build. Older
  extensions never send `agentId` and keep working against the new relay. Rollback: restore
  the previous binary and schema (both in `~/ulla-bella-backup-20261026-etapp3/`), restart
  the unit; the adapter is unchanged by etapp 3.

### 8.7 Verification

Automated: **181 JS tests** and **5 new Go tests** in `relay/agent_routing_test.go` — the
chosen agent only, an unallowed agent, an offline agent with no fallback, a job without
`agentId`, and the agents endpoint's scoping and live status. The JS additions are
`connections.test.js` and `multi-connection.test.js` (the model and the content script), and
the three service-worker suites described in §8.8.

Live routing on `ub-host` (relay 0.13.0 + two adapter processes, both on the real
Hermes, different workspaces):

| Check | Result |
|---|---|
| `GET /v1/sites/site_fs_test2/agents` | both agents, `connected: true`, grants only |
| job `agentId=agent_beta` | `~/ulla-bella-test-sites/agent-b/index.html` changed, the other workspace untouched |
| job `agentId=agent_pilot` | `~/ulla-bella-test-sites/example.test/index.html` changed, the other untouched |
| job `agentId=agent_ghost` | `403 agent_not_allowed` |
| job without `agentId` | routed by the documented legacy rule, done |
| `agent_beta` stopped, job for it | `503 agent_unavailable`, no silent fallback, no file changed |
| agents endpoint after the stop | `agent_beta.connected: false`, `agent_pilot.connected: true` |

Browser check (Chromium 145, real extension, real relay, 380×560): three connections
imported one after another (none replaced), all **Connected**, the chooser offered for the
origin with two connections, an explicit choice switching the page to the other connection,
an agent chosen for one site and shown as `Agent: Agent Beta` on that tab, tab switching
showing the right site for each tab, and Disconnect removing only its own connection
(`removedConnections` tombstone recorded, `activeByOrigin` of the other site intact).
Screenshots and `check.json` are in the etapp-3 review copy.

Known limits:

* Only one real Hermes instance is available here, so the two receivers differ by adapter
  process and workspace (which is what the routing decides) rather than by Hermes
  installation. A second Hermes would need only another `hermes.base_url` in an adapter
  config.
* The demo sites used for the browser check (`site_demo`, `site_demo2`, `site_demo3`) have
  no local tool config in `agent_beta`'s adapter; a job routed there would fail safely with
  "no tool configured for site" rather than editing anything.
* The chooser labels every candidate with its relay host, even when both are on the same
  relay; it stays correct, just redundant in that one case.

### 8.8 Correction pass — one receiver, one writer

Two defects were found against the *installed* worker (`pm-routing.test.js` reproduces
both). They are fixed here; the tests that demonstrate them live in
`test/pm-routing.test.js`, `test/connection-writes.test.js` and `test/job-routing.test.js`.

**1. A job could be sent through a connection the user did not choose.** `submitJob()`
resolved the receiver as `getConnection(id) || fallbackConnection({siteId})`, so an explicit
connection that had disappeared (disconnected in the other tab, removed by a migration)
silently fell back to *another* Relay that happened to host the same `siteId`, and the job
was POSTed there. The server might reject it, but the client must never send it at all.

Now:

* An explicit `connectionId` is honoured **exactly** or the round fails before any network
  call (`connection_not_found`). There is no fallback of any kind.
* The job is checked against the connection it claims: `site_mismatch` and
  `device_mismatch` are refused before the POST.
* A legacy message without `connectionId` (older content script) is resolved only when
  **exactly one** connection matches the job's `siteId`; zero → `site_not_configured`, more
  than one → `ambiguous_connection`.
* `resumePoll()` and the background's `resumeActiveJobs()` poll a job against its **stored
  snapshot** (`relayUrl`, `deviceCredential`, `connectionId`). A connection that was
  disconnected meanwhile does not move the poll: the round keeps the receiver it was
  accepted on. If neither snapshot nor connection can be identified, the record is marked
  `status: error` + `orphanedAt` and the tab is told; it is never re-pointed at another
  connection, and a restarted worker stops polling it.
* `fallbackConnection()` is gone. `connectionForRecord()` only ever looks a connection up by
  its exact id, and only to fill fields an old record left empty.

**2. Concurrent settings changes lost each other.** `setAgent()` (and every other settings
handler) read the whole connection map, changed one entry and wrote the whole map back. Two
overlapping handlers read the same snapshot and the later write erased the earlier change —
reproduced with `Promise.all([setAgent(site1,…), setAgent(site2,…)])`, where the first
choice vanished. Running everything in the service worker is not enough: the awaits overlap.

Now every mutation of the connection map and of the job list goes through **one queue**
(`serializeWrite`) in the worker: read → change → write happens inside the queue, and the
migration write happens in the same write as the change. That covers agent choice, import /
re-pairing, disconnect, per-origin active choice and the migration itself. The queue holds no
state that matters, so an MV3 restart simply starts with an empty queue; storage stays the
only source of truth and a reload sees every applied change.

Verification of this pass: 18 service-worker tests (both defects reproduced before the fix —
12 of the 18 failed on the previous commit — and all passing after), the full suite at
**181/181**, and the Go suites unchanged and green.

---

## Related documents

* `docs/ANNOTATION_QUEUE.md` — the 2.2 queue increments (this document supersedes its
  "keyed by origin" persistence note).
* `docs/ARCHITECTURE.md` — protocol and boundaries; etapp 2 added the optional job-wide
  `context.session` field (§7.3 here), which is the only Protocol V1 change.
* `docs/ROADMAP.md` — the 2.2 scope, now including sessions etapp 1 and 2.
