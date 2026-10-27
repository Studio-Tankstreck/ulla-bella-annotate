# Ulla-Bella — Chrome Extension

Point at an element on your website and tell Ulla-Bella what to change. The
edit is executed by Hermes through the installed Ulla-Bella Adapter and the
site's CMS (Joomla/YOOtheme), via the Ulla-Bella Relay.

This directory holds the **browser extension only**. The Relay, Adapter, and
protocol live elsewhere in this repository.

## Architecture

```
Chrome Extension  ──HTTPS──▶  Persistent Relay  ──WebSocket──▶  systemd Adapter
        │                                                          │
        └── annotation UI (content script,                        ▼
            registered per paired Site)                         Hermes ──▶ Site tool /
                                                                           YOOtheme MCP ──▶ CMS
```

- The extension's **service worker** is the only component that talks to the
  Relay. The content script never needs page-origin CORS.
- Protocol V1 is unchanged. The extension posts a Job envelope to
  `POST /v1/jobs` and polls `GET /v1/jobs/{jobId}` until a terminal
  `done`/`error` result.

## Paired-Site model

- On first run the popup shows **No website connected** and an
  **Import Website** button.
- Importing a `.ullabella` file (written by `relay invite create`) redeems the invite
  and stores a per-Site device credential in `chrome.storage.local`.
- After pairing, the extension requests the Site's **host permission** (a
  one-time prompt) and dynamically registers the annotation content script for
  that origin only. No `<all_urls>` content script, no broad permanent access.
- Editing is available only on the paired Site. On any other page the popup
  reports **This page is not connected**.

The device credential never appears in the UI or logs, and never leaves
`chrome.storage.local` except as the bearer token for Relay requests.

## Sessions

The annotation queue is a **session document** (one per connected Site + page,
`chrome.storage.local` key `ub.session.<siteId>|<pageId>`): its own id, description,
annotations, submitted round and the tombstones of everything removed from it. Removal is
permanent — every write is a merge where tombstones win — so a reload, a second tab or a
late job status cannot put a removed annotation back. A round is pinned to the Site/Relay
it was submitted to. Full model, migration and verification: [`../docs/SESSIONS.md`](../docs/SESSIONS.md).

## Relay origin policy

The extension only talks to a Relay whose origin is authorised (`src/relay-policy.js`).
A `.ullabella` file pointing anywhere else is rejected before any network request. There
are two build modes, and `scripts/package-extension.sh` writes both:

- **Portable** (`RELAY_PORTABLE=1`, what the public release is): no origin is baked in.
  `manifest.host_permissions` stays empty, the allowlist stays empty, and the popup asks
  for host access to the Relay origin named in the imported file — one prompt per Relay.
  The service worker then accepts that origin only while the permission is held.
- **Canonical** (`RELAY_ORIGIN=https://relay.example.com`): that one origin is substituted
  into both the manifest `host_permissions` and the policy allowlist, and no prompt is
  needed. Any other Relay is refused, even one the user granted permission for.

The packaging script fails the build if a placeholder survives, if the manifest and the
allowlist disagree, or if a secret or dev origin is found in the package.

## Layout

```
extension/
  manifest.json          MV3 manifest (version 0.1.0, version_name 0.1.0-beta)
  icons/                 icon16/32/48/128.png plus the -active variants
  src/
    background.js        service worker: pairing, Job submit/poll, script registration
    content.js           annotation-mode UI (registered per paired Site)
    lib.js               selector/DOM-path/annotation builders (Protocol V1)
    queue.js             pure queue helpers (page identity, results, caps)
    session.js           pure session model: identity, tombstones, merge-on-write
    pair.js              .ullabella parsing + invite redemption
    relay-policy.js      Relay origin allowlist
    popup.html/js/css    browser-action popup
    annotate.css         namespaced annotation UI styles
  test/                  Node `node:test` suites (run with `node --test`)
```

## Build a release package

```sh
# Portable build — no Relay baked in (the public release):
RELAY_PORTABLE=1 ./scripts/package-extension.sh

# Canonical build for one known Relay origin:
RELAY_ORIGIN=https://relay.example.com ./scripts/package-extension.sh
```

Output: `dist/ulla-bella-extension-0.1.0.zip` with `manifest.json` at the ZIP
root and no tests/fixtures/secrets. The script fails the build if it detects a
secret, a dev Site origin, or a dev IP in a non-dev build.

## Tests

```sh
# From the repository root. Explicit file paths (a bare directory is treated as
# a module by node's test runner); 204 tests.
node --test --test-force-exit extension/test/*.test.js
```

On Windows, copy `extension/` to a native path first — tests run from a
`\\wsl.localhost\...` UNC path hang. The suites load the REAL `content.js`
against `test/support/fake-dom.js` + `test/support/tab.js`, which provide a
hand-rolled DOM and an asynchronous `chrome.storage.local` so two "tabs" can be
driven against one shared store.

## Development vs release

The packaged build strips the old `src/config.js` dev fixtures entirely. Dev
pairing now uses the same flow as production: build a package with the dev
Relay origin, then **load the unpacked `dist/` directory** (or the ZIP) in
Chrome. There is no hardcoded dev Site or Relay in the extension source.
