# Ulla-Bella — Open source decision

**Status:** product decision (2026-10-15). License chosen: **MIT** (2026-10-27).

## The decision

There is exactly **one** version of Ulla-Bella. It is:

- **Free** to use.
- **Open source**, under the MIT license.
- **Free to self-host**.
- **Free to extend** under the same license.
- Without artificial limits on the number of connected websites.
- Without a Pro version, license keys, or feature-based paywalls.

There is no "Community vs. Pro" split and no gated features. Everything ships in one
open-source codebase.

## Business model — services, not licenses

The commercial model is built on **services**, not on selling the software:

- Installation
- Configuration
- Deployment
- Integrations
- Customisation for a company
- Maintenance
- Support
- Consulting

Norin Media can offer complete Ulla-Bella installations to companies. Other web agencies
and external developers are equally welcome to use, self-host, and contribute to the
project.

## License

The project's own code is released under the **MIT license** — see
[`../LICENSE`](../LICENSE), copyright © 2026 Norin Media AB.

- MIT was chosen because it is the least restrictive option that still requires the
  copyright notice: it lets agencies embed Ulla-Bella in client work without a licensing
  conversation, which is the same freedom the project wants for itself.
- **Third-party components keep their own licenses.** Dependencies are declared in
  `go.mod`/`go.sum`; where code or assets come from elsewhere, the upstream license and
  header stay in place. Do not relicense third-party code as MIT.
- The **name and artwork** are not covered by the MIT grant. Fork the code, but do not
  present a fork as the official Ulla-Bella distribution.
- Contributions are accepted under the same MIT license (see
  [`../CONTRIBUTING.md`](../CONTRIBUTING.md)).
