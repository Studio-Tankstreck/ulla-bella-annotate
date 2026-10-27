# Contributing to Ulla-Bella Annotate

Thanks for looking. This is beta software maintained by a small team, so the most useful
contributions are reproducible bug reports, documentation fixes and focused pull requests
that come with a test.

## Before you start

- For anything larger than a typo, open an issue first and describe what you want to
  change and why. That avoids two people building the same thing.
- Security issues go through [`SECURITY.md`](SECURITY.md), never a public issue.
- Do not include credentials, `.ullabella` files, customer site names, customer data,
  private hostnames or IP addresses in code, tests, fixtures or example configs. The demo
  suites use reserved names (`example.test`, `example.com`, `relay.example.com`,
  `192.0.2.x`).

## Development setup

```bash
git clone https://github.com/Studio-Tankstreck/ulla-bella-annotate.git
cd ulla-bella-annotate

export PATH="$HOME/.local/go/bin:$PATH"   # if Go lives in your home directory
go build ./...
./scripts/demo.sh                         # stub round trip, prints "Done"
```

Requirements: Go 1.27+, Node (any recent version) for the extension tests, Chrome for
manual testing. There is no package manager, no build step for the extension and no
runtime dependency beyond the Go modules in `go.mod`.

## Tests you must run

```bash
gofmt -l .                        # must print nothing
go vet ./...
go build ./...
go test ./... -count=1

./scripts/demo.sh                 # wire slice with the stub executor
./scripts/demo-private-beta.sh    # full lifecycle, ends with "PRIVATE-BETA LIFECYCLE: PASS"

cd extension && node --test test/*.test.js
```

On Windows, copy `extension/` to a native path before running the Node suite — a
`\\wsl.localhost\...` UNC path hangs the test runner.

To check the built package in a browser without a human click, note that current Chrome
releases ignore the `--load-extension` switch. Load the unpacked directory through the
DevTools **Extensions** domain instead — start Chrome with
`--enable-unsafe-extension-debugging --remote-debugging-port=9222` and call
`Extensions.loadUnpacked {"path": "<dir>"}` on the browser target. A portable build still
needs one human click for the Relay permission prompt; a build packaged with
`RELAY_ORIGIN=<origin>` does not.

Two habits that keep this codebase honest, both learned the hard way:

- **Prove a regression test bites.** Temporarily revert the fix on a throwaway copy,
  confirm the new test fails, then restore. A test that only ever passed proves nothing.
- **Test through the real modules.** The extension suites load the actual `content.js`,
  `background.js` and `session-writer.js` against small hand-rolled DOM/`chrome` shims
  rather than a second implementation of the logic.

## Pull requests

1. Branch from `main`, keep the branch short-lived, one topic per pull request.
2. Commit messages: `area: what changed` (e.g. `relay: reject a job whose site is
   disabled`). Body explains *why*; the diff explains *what*.
3. Add or update tests and docs in the same pull request. A behaviour change without a
   test will be sent back.
4. State what you actually ran. "Tests pass" is only useful with the command and the
   result.
5. Keep unrelated reformatting out — a whole-file whitespace diff hides the real change
   and the repository is LF-only.

## What lives where

| Area | Directory | Notes |
|---|---|---|
| Extension | `extension/` | Plain ES2020 + MV3, no bundler. Copy is in `extension/_locales/<lang>/messages.json`. |
| Relay | `relay/` | Go, SQLite (`modernc.org/sqlite`, no cgo). Operator CLI in `relay/cli.go`. |
| Adapter | `hermes-adapter/` | Go. Config-driven; secrets are env-var **names** only. |
| Protocol | `protocol/` | Protocol V1 JSON Schemas. `docs/ARCHITECTURE.md` is the authority — don't change the protocol in a pull request without discussing it first. |
| Docs | `docs/` | English. |

### Adding a UI string

`extension/_locales/<lang>/messages.json` is the source of the wording for all nine
languages. After editing any locale file:

```bash
python3 scripts/build-i18n.py           # regenerate extension/src/i18n-messages.js
python3 scripts/build-i18n.py --check   # fails if the bundle is stale
```

Never hand-edit `extension/src/i18n-messages.js`. A new key must exist in **all nine**
locales; `extension/test/i18n.test.js` enforces key parity and placeholders.

### Adding a new `src/` module to the extension

Five places must know about it, or it works unpacked and 404s in the packaged build:
`background.js` (`importScripts`), the dynamic content-script list, `injectIntoActiveTab`,
`popup.html`, and the copy list plus required-file check in
`scripts/package-extension.sh`.

## Third-party code

Everything vendored or depended on keeps its own license and copyright. Today the
dependencies are Go modules declared in `go.mod`/`go.sum` (all permissive: MIT, BSD,
Apache-2.0) and the icons in `graphics/`/`extension/icons/`, which are the project's own
artwork. If you add a dependency or copy code from elsewhere, say so in the pull request,
keep the upstream license header, and do not relicense it as MIT.

## License of your contribution

By contributing you agree that your contribution is licensed under the MIT license in
[`LICENSE`](LICENSE), and that you have the right to submit it.
