# .ullabella — Site onboarding file (V1)

A `.ullabella` file is the smallest possible thing a customer needs to pair
their browser with one Ulla-Bella Site. It carries **only** bootstrap
information: where the Relay is and a short-lived, single-use invite token.

It must be safe to hand to a customer. It deliberately contains **nothing**
that would let someone edit the Site, reach the Agent, or access any CMS.

## Format

```json
{
  "format": "ulla-bella-site",
  "version": "1",
  "relayUrl": "https://relay.example.com",
  "invite": "ub_fake_disposable_token_do_not_use"
}
```

| Field       | Type   | Meaning                                                    |
|-------------|--------|------------------------------------------------------------|
| `format`    | string | Fixed `"ulla-bella-site"`. Rejects anything else.          |
| `version`   | string | Format version, currently `"1"`.                           |
| `relayUrl`  | string | The Relay base URL (http/https, no userinfo).              |
| `invite`    | string | Single-use, short-lived token minted by the Relay operator.|

No other field is read. Extra fields are ignored and never interpreted (they
cannot escalate permissions or override authorization).

## What it MUST NOT contain

- Hermes API key, MCP API key, CMS/Joomla/WordPress credentials
- SSH keys, FTP/SFTP credentials, LLM/OpenRouter credentials
- long-lived Agent or Device credentials
- any reusable privileged Relay secret

The Device ID, Site origin, permissions, and the long-lived device credential
all come **from the Relay after redemption**, never from the imported file.
The Relay is authoritative.

## Invite lifecycle

```
relay invite create <siteId>        # operator mints a single-use invite
  -> writes <display-name>.ullabella
  -> token exists ONLY in that file (never stdout/stderr/logs)

extension imports the file
  -> POST <relayUrl>/v1/pair { "invite": "..." }
  -> Relay verifies: exists, not expired, not redeemed, Site exists
  -> Relay mints a scoped Device + returns deviceCredential (exactly once)
  -> invite is marked redeemed (unusable from now on)
```

Properties of an invite:

- **short-lived** — default 24h (`--ttl`; `0` = default, negative = pre-expired).
- **single-use** — first successful redemption invalidates it.
- **scoped to one Site** — the resulting Device is allowed only that Site.
- **unusable after redemption** → `invite_already_used` (HTTP 409).
- **unusable after expiry** → `invite_expired` (HTTP 410).
- **unknown token** → `invite_not_found` (HTTP 404).

## Pairing response (what the extension stores)

```json
{
  "deviceId": "dev_xxxxxxxx",
  "siteId": "site_ub_joomla",
  "origin": "https://joomla.example.test",
  "displayName": "Ulla-Bella Joomla",
  "deviceCredential": "ubd_<64 hex chars>"
}
```

The extension persists this into `chrome.storage.local`. The credential is a
high-entropy (256-bit) opaque bearer, scoped to exactly one Site, stored on the
Relay only as a SHA-256 hash.
