# Changelog

All notable changes to Ulla-Bella Annotate are recorded here. The project is in beta on
the way to `1.0.0`; the format follows the spirit of Keep a Changelog, and versions follow
Semantic Versioning.

## 0.1.0-beta.1 — 2026-10-27

First public release. Beta: interfaces, operator commands and the configuration format may
still change before 1.0.0.

### Added

- **Annotation rounds from the browser.** Select an element, describe the change, queue up
  to eight, send them as one round, and read a per-item verdict (✓ done, ✗ failed,
  ? unknown) when it comes back.
- **Sessions.** Each connected site + page keeps a session document with its own id,
  description and tombstones, so a removed annotation stays removed across reloads, tabs
  and late job results, and any number of "clear session" is safe.
- **Several connections with a chosen agent.** One browser can hold connections to several
  relays/sites; when a page could belong to more than one, the popup asks which connection
  to use, and the agent for that site is picked from the Relay's authorised list.
- **Nine UI languages** (en, sv, de, es, it, nl, nb, da, fi) with an *Automatic* or manual
  choice, plus translated relative times and plurals.
- **Relay** (Go, SQLite): device and agent authentication with credentials hashed at rest,
  per-site agent authorisation, persistent job and result state, job-id idempotency,
  rate limits and body limits, `/healthz` + `/readyz`, and an operator CLI for sites,
  agents, grants, invites and device revocation.
- **Adapter** (Go, installable service): config-file driven with secrets referenced by
  env-var name, outbound-only WebSocket to the Relay, durable Hermes runs with idempotent
  admission and resume after a restart, per-annotation verification, `validate` and
  `doctor` commands, and three site tools — `filesystem`, `yootheme-mcp` (Joomla +
  YOOtheme Pro) and `emdash` (EmDash REST).
- **Protocol V1** JSON Schemas for envelopes, jobs and results, with fixtures.
- **Portable Relay configuration.** `RELAY_PORTABLE=1 ./scripts/package-extension.sh`
  builds an extension with no Relay baked in: `host_permissions` stays empty and the user
  grants their own Relay origin when importing a `.ullabella` file. A canonical build
  (`RELAY_ORIGIN=<origin>`) still bakes exactly one origin.
- **Documentation**: architecture, relay setup, adapter install, operations, sessions,
  i18n, the `.ullabella` file, and a public README with the permission and data-flow
  description.

### Changed

- The extension's manifest declares `version_name` `0.1.0-beta`; the numeric version stays
  `0.1.0`.
- Example configuration and fixtures use reserved example domains and hosts instead of a
  real deployment's addresses.

### Fixed

- A demo round could be rejected as "expected accepted, got HTTP 200" when a script
  re-submitted an unchanged payload: each regenerated job now carries a fresh job id, so
  the idempotency path is not mistaken for a failure.
- The extension asks for the Relay permission only where a portable build needs it, and
  still refuses any Relay origin it was not granted.

### Known limitations

See [Beta status and known limitations](README.md#beta-status-and-known-limitations):
unpacked installation only (no store listing yet), three site tools, browser-side cancel
missing, eight annotations per round, operator CLI only for administration, and HTTPS is
your responsibility in front of the Relay.
