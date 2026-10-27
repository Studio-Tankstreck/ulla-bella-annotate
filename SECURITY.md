# Security policy

Ulla-Bella Annotate drives edits on **your** websites through **your** agent. A security
problem here is usually one of: something reaches a site or an agent it should not, a
credential leaks, or a job runs twice.

## Supported versions

| Version | Supported |
|---|---|
| `0.1.x` (beta) | yes — fixes land on `main` |
| anything older | no |

Only the current `main` plus the latest published beta release get security fixes.

## Reporting a vulnerability

**Please do not open a public issue.**

1. Go to the repository's **Security** tab →
   <https://github.com/Studio-Tankstreck/ulla-bella-annotate/security/advisories/new>
   (GitHub private vulnerability reporting). That opens a private advisory visible only to
   the maintainers.
2. If that form is unavailable to you, open a **public** issue containing only: *"security
   report — please open a private channel"*, and no technical detail. A maintainer will
   reply with a private channel.
3. Include, where you can: affected version (`ulla-bella-adapter --version`, the version on
   `chrome://extensions`), the affected component (extension / relay / adapter / protocol),
   reproduction steps, and the impact you believe it has.

Never include a working credential, a `.ullabella` file, a device or agent credential, a
customer's site name or any personal data in a report. If a credential is already exposed,
say which kind it was and revoke it — `relay device revoke <deviceId>` for a browser,
`relay agent create` a replacement for an agent, and rotate the Hermes API key and the site
tool token in the Adapter's env file.

## What to expect

This is a small beta project, so no formal SLA. Reports are acknowledged as soon as a
maintainer sees them; a confirmed issue is fixed on `main` and noted in
[`CHANGELOG.md`](CHANGELOG.md). Please give us a reasonable window to ship a fix before
publishing details.

## Security model, in one page

Knowing what the design does and does not promise makes a report much easier to judge.

- **Trust boundaries.** The browser is untrusted by the Relay (it must present a device
  credential for a site it was paired with). The Relay is the authority for *which agent
  serves which site*. The Adapter is trusted by the operator who runs it and holds the
  site tool token and the agent key. The agent executes with the site tool's own
  permissions — scope the token you give it to what that site really needs.
- **Credentials are hashed at rest.** Invite, device and agent credentials are stored as
  SHA-256 hashes in the Relay database; the raw value exists only at mint time (and inside
  the `.ullabella` file for an invite). The browser keeps its device credential in
  `chrome.storage.local` only.
- **The Adapter makes outbound connections only.** It never listens; do not expose it.
- **The Relay is plain HTTP/WSS.** Put TLS in front of it for anything beyond a trusted
  network, and mint invites with `RELAY_PUBLIC_URL` pointing at the public URL.
- **An imported file cannot widen network access.** A `.ullabella` file may only name an
  origin this build already allows (canonical build) or one you granted at import time
  (portable build). Everything else is rejected before a request is made.
- **No remote code.** The extension ships every script it runs; there is no `eval`, no
  remote `<script>`, no CDN and no CSP override.
- **Idempotency.** Every job is admitted under an idempotency key, so a retry cannot
  execute the same round twice; a job whose delivery is uncertain is marked as such rather
  than silently re-run.

Out of scope for this project: misconfiguration of your own agent's permissions, a
compromised Relay host, and anything that requires an attacker to already hold your operator
credentials.
