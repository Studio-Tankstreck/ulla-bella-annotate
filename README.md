# Ulla-Bella Annotate

Point at an element on a web page, describe the change — and get a **verified** result
back. No CMS login, no template editing, no guessing whether it worked: the agent that
performs the change also proves it happened before reporting *Done*.

**Status: public beta — `0.1.0-beta`.** This is beta software on the way to 1.0.0. It is
used daily on real sites, but the extension UI, the operator commands and the
configuration format may still change. See [Beta status and known
limitations](#beta-status-and-known-limitations) before you install it.

---

## What it does

1. You open a connected website in Chrome and switch on editing.
2. You click an element — a heading, a paragraph, a button — and write an instruction
   ("Change this heading to *Our Services*").
3. You queue as many instructions as you need on that page (up to eight per round) and
   send them together.
4. The extension posts one *round* to your Relay. The Relay routes it to the Adapter for
   that site, and the Adapter asks your agent (Hermes) to perform the edits on the site's
   own tooling — a CMS API, a page builder's MCP server, or a local checkout.
5. The agent reports back, the Adapter re-checks the page itself, and the extension shows
   per-item results: ✓ done, ✗ failed, ? unknown.

The point is the last step. A model that says "done" is not evidence; the Adapter runs a
deterministic postcondition on every item (for example: the old visible text is gone from
the live page) and downgrades anything that fails it.

## How the pieces fit together

```
Chrome extension          Relay                      Adapter                  Hermes
(MV3, per site)     (authn + routing,          (outbound connection,     (reasoning and
                     SQLite job store,          site + tool policy)       execution agent)
                     no CMS credentials)
      |  HTTPS/WSS        ^  outbound WSS             |                        |
      +-------------------+---------------------------+                        |
                                                                              v
                                                                    Site tool / CMS
                                                                    (YOOtheme MCP → Joomla,
                                                                     EmDash REST, filesystem)
```

- **Chrome extension** (`extension/`) — the only user interface. Selects elements, keeps
  the annotation queue, submits a round, shows per-item results. It never holds CMS
  credentials.
- **Relay** (`relay/`) — authenticates *devices* (browsers) and *agents* (adapters),
  authorises which agent may serve which site, and stores job and result state in SQLite
  so a restart cannot lose a round. It never holds CMS credentials.
- **Adapter** (`hermes-adapter/`) — runs next to your agent, opens an **outbound**
  WebSocket to the Relay (no inbound ports), turns a job into a task for Hermes, runs the
  site's tool, and verifies the outcome.
- **Hermes** — the agent that reasons about the page and executes the change through the
  site's tool. The protocol is agent-agnostic; this Adapter is the Hermes implementation.
- **Wire protocol** — Protocol V1, a small JSON Job/Annotation/Result model in
  `protocol/`. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the authority on it.

## What is in this repository

| Path | What it is |
|---|---|
| `extension/` | Chrome Manifest V3 extension — the annotation UI, queue, sessions, nine-language UI |
| `relay/` | Relay server (Go): device/agent auth, site routing, SQLite store, operator CLI |
| `hermes-adapter/` | Adapter service (Go): durable Hermes runs, site tools, verification, `doctor` |
| `internal/` | Shared Go packages: protocol types (`proto`), SQLite store (`store`) |
| `protocol/` | Protocol V1 JSON Schemas + fixtures |
| `client/` | Small Go client used by the demo scripts to submit a job and poll it |
| `scripts/` | Demo, packaging, i18n and install scripts |
| `deploy/` | Example adapter config, env file and systemd unit |
| `docs/` | Architecture, operations, adapter install, relay setup, sessions, i18n |

**Required to run it:**

- **Go 1.27+** to build the Relay and the Adapter (Linux, macOS or WSL).
- **Node** (any recent version) to run the extension's unit tests. The extension itself
  has no build step and no dependencies.
- **Chrome** (or any Chromium-based browser) to load the extension.
- **Hermes** with its API server enabled — the Adapter submits durable runs through
  `POST /v1/runs` and polls `GET /v1/runs/{id}`. Absent Hermes, the scripts still run with
  the stub executor (see below).
- A **site tool** for the site you want to edit: a YOOtheme MCP endpoint (Joomla), an
  EmDash REST endpoint, or a local directory checkout for the `filesystem` tool.

No hosted service is required, and none is provided: the Relay and the Adapter run on
your own machine or server.

## Install and run

Everything below is copy-pasteable and was executed for the 0.1.0-beta release.

### 1. Build and run the scripted demo (no agent required)

```bash
git clone https://github.com/Studio-Tankstreck/ulla-bella-annotate.git
cd ulla-bella-annotate

# build relay + adapter + client into ./bin
./scripts/demo.sh
```

`demo.sh` starts a Relay and an Adapter with the **stub** executor, mints a site, an agent
and a single-use invite, pairs a device, submits a job and prints `Done`. It uses a
temporary database and stops everything on exit — nothing is left running.

For the full operator lifecycle (site → agent → grant → invite → pair → job → relay
restart survival → device revoke):

```bash
./scripts/demo-private-beta.sh
# ends with: PRIVATE-BETA LIFECYCLE: PASS
```

### 2. Run the checks

```bash
gofmt -l .                       # must print nothing
go vet ./...
go build ./...
go test ./... -count=1

cd extension && node --test test/*.test.js
```

On Windows, run the extension tests from a native path (a `\\wsl.localhost\...` UNC path
hangs the Node test runner): copy `extension/` to e.g. `C:\ub-ext` and run there.

### 3. Install the extension from the release ZIP

The released ZIP is a **portable** build: it contains no Relay address and no relay host
permission. You grant your own Relay when you import your first `.ullabella` file.

1. Download `ulla-bella-extension-0.1.0.zip` from this repository's *Releases* page and
   check it against the published SHA-256 (see the release notes).
2. Unpack it into a directory that stays put, e.g. `C:\ulla-bella-extension`.
3. Open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked** and
   select that directory.
4. Pin the extension so the toolbar icon is visible.

To update later, replace the directory's contents and click the reload arrow (↻) on
`chrome://extensions`. Do not click *Remove* — that also erases your stored connections.

### 4. Run a Relay, an agent and an Adapter

```bash
# Relay: listens on 127.0.0.1:8787 by default (use RELAY_ADDR to change the bind)
export PATH="$HOME/.local/go/bin:$PATH"
go build -o bin/relay ./relay
SCHEMA_DIR=protocol RELAY_DB_FILE=./data/ulla-bella.db ./bin/relay
```

The Relay has no web UI; everything is an operator command against the same database:

```bash
# a site your browser may edit
./bin/relay site create site_example --origin https://example.com --name "Example"

# the agent that serves it (the credential is printed exactly once)
./bin/relay agent create agent_main --name "Main agent"

# authorise that agent for that site
./bin/relay agent grant-site agent_main site_example

# a single-use invite for a browser (.ullabella file in --out)
RELAY_PUBLIC_URL=https://relay.example.com ./bin/relay invite create site_example --out .
```

The Adapter runs from its own config file (`deploy/adapter.example.yaml` is a complete
example) and needs Hermes:

```bash
go build -o bin/ulla-bella-adapter ./hermes-adapter
./bin/ulla-bella-adapter --config ~/.config/ulla-bella/adapter.yaml --env-file ~/.config/ulla-bella/adapter.env
```

`--config … --env-file …` alone **starts** the service (there is no `serve` subcommand).
Two extra commands are useful before you trust it:

```bash
./bin/ulla-bella-adapter --config … --env-file … validate   # config only, exits != 0 on error
./bin/ulla-bella-adapter --config … --env-file … doctor     # Relay, Hermes, credential, site tool
```

`doctor` prints what it checked and never prints a secret value. Installation as a
systemd service, the env-file layout and the secret rules: [`docs/ADAPTER_INSTALL.md`](docs/ADAPTER_INSTALL.md).
Running the two services day to day: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

### 5. Connect your own Relay

The extension accepts a Relay only if **you** granted that origin. With the portable
build, importing a `.ullabella` file asks for host access to the Relay origin it names
(one browser prompt per Relay); nothing else is contacted. A canonical build
(`RELAY_ORIGIN=https://relay.example.com ./scripts/package-extension.sh`) instead bakes
one origin in and needs no prompt. Details, including what a `.ullabella` file is allowed
to contain: [`docs/RELAY.md`](docs/RELAY.md) and [`docs/ULLABELLA_FILE.md`](docs/ULLABELLA_FILE.md).

### 6. Build the extension package yourself

```bash
# portable (public) build — no Relay baked in, empty host_permissions
RELAY_PORTABLE=1 ./scripts/package-extension.sh

# canonical build for one known Relay
RELAY_ORIGIN=https://relay.example.com ./scripts/package-extension.sh
```

Output: `dist/ulla-bella-extension-<version>.zip`, `manifest.json` at the ZIP root, no
tests, no fixtures. The script fails the build on a secret, a dev origin, a leftover
placeholder, a missing locale, or a manifest/version mismatch.

## An example annotation flow

Clicking the *H1* "Tjänster" on your page and writing *Change this heading to Our
Services* produces one annotation. A round of one sends this Job (Protocol V1):

```json
{
  "schemaVersion": "1",
  "messageType": "job",
  "payload": {
    "jobId": "job_01j7xb4c5",
    "siteId": "site_01j7x9k2m",
    "deviceId": "dev_…",
    "annotations": [
      {
        "annotationId": "ann_01j7xb4c6",
        "instruction": "Change this heading to Our Services",
        "target": {
          "url": "https://example.test/services",
          "pageTitle": "Tjänster — Example Test",
          "elementType": "h1",
          "visibleText": "Tjänster",
          "selector": "h1.hero-title",
          "rect": { "x": 0, "y": 120, "width": 640, "height": 48 }
        },
        "context": { "nearbyText": "Vi hjälper företag att växa." }
      }
    ]
  }
}
```

What happens then:

1. The Relay returns `accepted` and forwards the job to the Adapter that serves
   `site_01j7x9k2m` — after checking that this device may submit for that site and that
   the agent is granted for it.
2. The Adapter submits a durable Hermes run (idempotent, so a crash cannot execute the
   same job twice) and acknowledges `working`.
3. Hermes locates the element — the visible text is the resolution key, the selector and
   DOM rect are hints — and performs the edit through the site's tool.
4. The Adapter re-reads the page: is the old text gone? Only then is the item `done`.
   The result carries a per-item verdict, so a round can be `2 completed · 1 result
   unknown` rather than a misleading all-green.
5. The extension shows ✓ next to the item; the marker and the session record stay until
   you clear the session.

## The nine UI languages

The extension's own interface ships in **English, Swedish, German, Spanish, Italian,
Dutch, Norwegian Bokmål, Danish and Finnish**, with an *Automatic* choice (follow the
browser) or a manual one. The browser-controlled strings — the extension name,
description and menu item — always follow the browser's UI language, because Chrome
answers those itself. Copy lives in `extension/_locales/<lang>/messages.json`;
`scripts/build-i18n.py` bundles it and `--check` fails if the bundle drifts. Full
description: [`docs/I18N.md`](docs/I18N.md).

## Beta status and known limitations

This is `0.1.0-beta`, the last step before 1.0.0. It is not a stable API:

- **Installation is unpacked-only.** There is no Chrome Web Store listing yet, so there
  are no automatic updates — you replace the directory and reload.
- **Site tools are specific.** The Adapter implements `filesystem`, `yootheme-mcp`
  (Joomla + YOOtheme Pro) and `emdash` (EmDash REST). There is no generic "any CMS"
  path; a new tool type is a code change.
- **Verification is deterministic per tool, not universal.** For the filesystem tool the
  postcondition checks an `h1`; for the CMS tools it re-reads the live page and asserts
  the old text is gone. Elements without such a check fall back to the agent's report.
- **The browser cannot cancel a round.** Once sent, a round runs to completion; results
  for a cleared session are discarded instead.
- **Eight annotations per round**, one round per page session at a time.
- **The Relay has no admin UI.** Sites, agents, grants and invites are operator CLI
  commands against the SQLite file.
- **Single-tenant by design.** One Relay serves the sites and agents you configure; there
  is no hosted or multi-customer service.
- **Use HTTPS for anything reachable from the internet.** The Relay speaks plain HTTP/WSS;
  put a TLS-terminating reverse proxy in front of it and mint invites with
  `RELAY_PUBLIC_URL` set to the public URL.
- **Interface languages are a manual choice** for the extension's own UI only; Chrome's
  own surfaces follow the browser.

## Reporting problems

- **Bugs and feature requests:** open an issue at
  <https://github.com/Studio-Tankstreck/ulla-bella-annotate/issues>. Please include the
  extension version (from `chrome://extensions`), the Adapter version
  (`ulla-bella-adapter --version`), and the failing job's status — never a `.ullabella`
  file, a device credential or an agent credential.
- **Security problems:** do **not** open a public issue. See [`SECURITY.md`](SECURITY.md).

## Permissions and data flow

The extension asks for as little as it can:

| Permission | Why |
|---|---|
| `storage` | Keep your connections, the session documents and the device credential in `chrome.storage.local`, on this device. |
| `alarms` | Resume polling a running round after the service worker is suspended. |
| `scripting` | Register the annotation overlay on the origin you connected, and inject it when you switch editing on. |
| `activeTab` | Read the current tab's address when you open the popup, to tell you whether that page belongs to a connected site. |
| `tabs` | Read the active tab's URL in the service worker to decide where to inject. |
| Host access | Only the site origins you grant (one prompt per site) and the Relay origin you grant (portable build) or the packaged Relay origin (canonical build). |

No `<all_urls>` content script, no analytics, no telemetry, no remote code. What leaves
the browser, and only when you press *Send*:

- the page URL and page title of the connected site,
- the selected element's visible text, element type, selector and DOM rect,
- a short piece of nearby text used as context,
- your instruction text,
- the device credential, as a bearer token to your own Relay — and nothing else.

Where it goes: extension → **your** Relay (HTTPS) → **your** Adapter (outbound WSS) →
**your** agent and the site's tool. The Relay never holds CMS credentials; the Adapter
holds the site tool token and the agent key in a file readable only by its own user.
Data retention is whatever your Relay database and your agent's session store keep.
Full privacy description: [`docs/WEBSTORE.md`](docs/WEBSTORE.md).

## Development

- [`.gitignore`](.gitignore) keeps credentials, `.ullabella` files, runtime databases and
  release packages out of the tree.
- Every behavioural change needs a test; the extension suites drive the **real**
  `content.js` and `background.js` against hand-rolled DOM and `chrome` shims, so no
  browser is needed for the unit tests.
- Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.

## License

MIT — see [`LICENSE`](LICENSE). Copyright © 2026 Norin Media AB.

Third-party components keep their own licenses (see
[`CONTRIBUTING.md`](CONTRIBUTING.md#third-party-code)). The project's own source is MIT;
the Ulla-Bella name and artwork are not part of that grant.
