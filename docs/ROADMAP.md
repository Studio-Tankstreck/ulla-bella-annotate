# Ulla-Bella — Roadmap

This is the project roadmap. It is a living document; update it here when the plan
changes.

## Current — Ulla-Bella 2.2

A stable Chrome Extension and a documented, coherent open-source platform.

- Annotation queue (up to 8 edits per round) with per-annotation results.
- Two proven site tools: Joomla (YOOtheme MCP) and infraverket (EmDash).
- Toolbar icon (grey/green per tab).
- Persistent Relay (SQLite) + installable Adapter (systemd).
- Durable asynchronous Hermes execution (jobs survive minutes + restarts; see
  `docs/HERMES-ASYNC.md`).
- Live agent activity in the job-progress panel (Task 4B) — real Hermes activity
  ("Executing tools", "Verifying", "Waiting for approval") with honest "last agent
  activity" timestamps.
- Admission recovery + terminal-result safety (Task 4B.1) — a submit-time disconnect
  re-recovers the same run via its Idempotency-Key (no double execution), and a late
  `working` update can never overwrite a settled `done`/`error`.
- User acceptance test (Task 5) — an isolated filesystem test site (`site_fs_test2`,
  origin `http://site.example.com:8080`) verified end-to-end against real Hermes: a batch of 3
  annotations returned three `done` per-annotation results, live activity was observed
  (`working` → `using_tools`), a `sleep 20` job exercised the quiet-tool-call path, and the
  edited file was confirmed on disk. The real-Chrome click-through is pending manual
  verification.
- Annotation result reporting (Task 5.1) — the extension now reuses the queue's stable
  `annotationId` when submitting, so the Relay's per-annotation results render correctly
  (green ✓ / red ✗ / grey ?) instead of a spurious "0 of N completed successfully".
- Sessions etapp 1 — durable deletion and the session foundation (see
  [`docs/SESSIONS.md`](SESSIONS.md)): one session document per connected site + page with a
  stable id, tombstones so a removed annotation can never come back (reload, second tab,
  late status), merge-on-write instead of last-writer-wins, per-site isolation, a named
  *Clear session* action, honest wording for removals during a running round, a one-time
  migration of the pre-2.2 `queues` state, and a per-round snapshot of the site/relay it was
  submitted to. Etapp 2 (description + marker popover) and etapp 3 (multi-site/multi-agent
  settings) are planned in the same document.

  **Review round 1 (after the first commit):** two defects were found and fixed in the same
  stage — concurrent writes in two tabs could still lose a deletion (the write path is now a
  single worker-side queue per session key, with retries across worker restarts), and a
  session cleared more than once could be resurrected by a very old view (now decided by a
  stable `lineageId` + a monotonic `generation`, so no history is needed). 11 concurrency
  regression tests were added; 8 of them fail on the previous commit.

- Sessions etapp 2 — the session UX and the job-wide context (see
  [`docs/SESSIONS.md`](SESSIONS.md) §7): a *Session description* first step that can be
  skipped and never returns for the same session, the description readable/editable in the
  panel and sent as an optional `context.session` through schema → relay → adapter into the
  actual Hermes prompt (once, clearly separated from the annotations), a keyboard-accessible
  comment popover on every numbered marker, and a visible, actionable save status (Retry, or
  an explicit "add them back" after a clear in another tab). Verified end to end against the
  running stack and the real Hermes prompt.

## Sessions etapp 3 — several sites and a chosen agent (implemented)

One extension, several connected sites, and a server-checked agent choice per site (see
[`docs/SESSIONS.md`](SESSIONS.md) §8): connections identified by relay + site, sessions
keyed per connection, an idempotent migration from the single pairing, a settings view with
verified status (unreachable ≠ unknown), the agent list from the Relay's
authorization-checked endpoint, a job pinned to the connection/agent it was sent to, and no
silent fallback when the chosen agent is offline. Verified live with two adapter processes
and in a real browser.

## i18n — nine UI languages (implemented, approved for private beta)

The extension's own interface ships in **nine languages** — English, Swedish, German,
Spanish, Italian, Dutch, Norwegian bokmål, Danish and Finnish — with an *Automatic*
follow-the-browser default and a manual per-user choice in the popup's settings (see
[`docs/I18N.md`](I18N.md)). The copy lives in `extension/_locales/<lang>/messages.json`
(Chrome's own format, 163 keys, also read by Chrome for the manifest strings); a
generated bundle plus `test/i18n.test.js` keep the two in step. An open editor tab
relabels in place when the choice changes, and Chrome-owned surfaces (extension name,
description, menu entry, Web Store) stay on the browser language by design.

- **Status:** approved for private beta — nine languages, layout checked in German and
  Finnish at 320–1280 px wide and down to 360 px tall.
- **Last reported commit:** `212e562` on branch `feat/i18n` (main work `1d93440`).
  Not pushed, not merged, not released.
- **Verified:** 198/198 tests green (181 before the work), a browser **restart** keeps a
  manual choice and applies it in both popup and editor, and **real annotation rounds**
  against the live Relay/adapter/Hermes stack were run in Swedish (one annotation →
  *1 av 1 slutförda* with ✓, a two-annotation batch → *2 av 2 slutförda*), including the
  edited file on the test site.
- **Outstanding before a later publishing decision:** an external review of the nine
  translations (they were written by the implementing agent, not native speakers) and
  translated Web Store listing texts. Neither is needed for private beta. Internal
  diagnostic messages stay English on purpose.
- **Integration:** `feat/i18n` is built on `feat/sessions-etapp-1` (with etapp 2 and 3)
  and touches files whose current content exists only there, so merging into `main`
  awaits separate approval of that sessions work.

## Next — further multi-agent work

The 2.2 goals for several sites and several agents are met by etapp 3. What remains is
operational polish, not architecture:

- **Portable settings export/import** — sites and agent preferences only, never credentials
  (a `.ullabella` re-import per site works today; a single settings bundle does not exist).
- **Agent health beyond connected/offline** — the endpoint reports whether an adapter socket
  is live; a slow or erroring agent is only visible per job.
- **Per-site "clear session" in the settings view** — clearing exists in the editor for the
  current page; a list-wide action with a session count per connection is not built.
- **A second Hermes instance per agent** — the routing already takes `hermes.base_url` from
  the adapter config, so this needs no code, only a second adapter process and config.
- **Provider-side rate/scope limits per connection** — the Relay authorizes per site and per
  agent; per-connection quotas are not modelled.
