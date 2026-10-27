# Installing the Ulla-Bella Adapter

The **Adapter** is the component that runs on a Hermes machine, connects outbound
to the Ulla-Bella Relay, authenticates as an Agent, and drives local Site tools
(YOOtheme MCP → Joomla) through the local Hermes gateway. Task 13 packages it as
a persistent systemd service.

Scope: **Linux / systemd only** (matches the current Hermes deployment). Windows
service / launchd / container packaging are future work, not implemented here.

```
Customer Chrome
      ↓
Public HTTPS Relay
      ↓  outbound WSS (Adapter initiates)
Customer/operator Hermes machine
      ↓
local Hermes + Site tools
```

Hermes itself is never exposed; the Adapter only makes outbound connections.

## Requirements

- Linux with systemd (Ubuntu 24.04+ tested).
- Root/sudo for installation.
- Go toolchain **or** a prebuilt binary (see `--binary`).
- A running Relay, an Agent provisioned on it, and a local Hermes gateway.

## Install

```bash
sudo scripts/install-adapter.sh
# or with a prebuilt binary (no Go needed on the target):
sudo scripts/install-adapter.sh --binary /path/to/ulla-bella-adapter
```

The installer:

1. builds/installs the binary to `/usr/local/bin/ulla-bella-adapter`,
2. creates `/etc/ulla-bella/`,
3. creates the `ullabella` system user,
4. installs an example config (only if absent — never overwrites),
5. installs a protected empty env file (only if absent),
6. installs and reloads the systemd unit,
7. prints the remaining steps.

## Configuration

Config lives at `/etc/ulla-bella/adapter.yaml`. It holds **no secrets** — every
secret is referenced by the *name* of an environment variable.

```yaml
relay:
  url: wss://relay.example.com/v1/ws
agent:
  id: agent_xxx
  credential_env: ULLABELLA_AGENT_CREDENTIAL
hermes:
  base_url: http://127.0.0.1:8642
  model: hermes-agent
  api_key_env: API_SERVER_KEY
sites:
  - site_id: site_example
    origin: https://example.com
    tool:
      type: yootheme-mcp
      endpoint: https://mcp.example.com/api/index.php/v1/yt-builder-mcp
      token_env: EXAMPLE_YTB_MCP_TOKEN
      host_header: example.com     # optional (tunnel/noncanonical endpoints)
      client_version: "2.3.1"       # optional (defaults to 2.3.1)
```

### Site/tool mapping

Each `sites[]` entry is a Site the Adapter *knows how to operate*. Authorization
("may this Agent serve this Site?") lives in the Relay DB and is enforced by the
Relay at registration — the Adapter never self-authorizes. The Relay replies with
the granted Site IDs; the Adapter intersects them with its local config and logs
a warning (and fails safely) for any granted Site it has no tool config for.

`tool.type: yootheme-mcp` is the only implemented tool type today; the schema
leaves room for more without a plugin framework.

## Secret handling

Secrets live in `/etc/ulla-bella/adapter.env` (mode `0600`, `root:root`), loaded
by systemd's `EnvironmentFile=`:

```
ULLABELLA_AGENT_CREDENTIAL=...
API_SERVER_KEY=...
EXAMPLE_YTB_MCP_TOKEN=...
```

The config references **names only**. Values are never written to the config, to
Git, to command history, or to logs (`validate`, `doctor`, startup and error
messages print env-var names, never values).

## Provisioning the Agent (once)

On the Relay machine, create the Agent and grant it the Site, then copy the
minted credential **only** into this machine's `adapter.env`:

```bash
relay agent create agent_xxx --name "Customer A"
relay agent grant-site agent_xxx site_example
# the printed credential goes into /etc/ulla-bella/adapter.env (ULLABELLA_AGENT_CREDENTIAL=...)
```

## Validate

```bash
ulla-bella-adapter --config /etc/ulla-bella/adapter.yaml \
  --env-file /etc/ulla-bella/adapter.env validate
```

Checks config syntax, duplicate/empty Site IDs, malformed origins, unsupported
tool types, missing MCP endpoint/credential refs, and that every referenced
secret is present. Exits non-zero on any problem. It never contacts any Site.

## Doctor (connectivity check)

```bash
ulla-bella-adapter --config /etc/ulla-bella/adapter.yaml \
  --env-file /etc/ulla-bella/adapter.env doctor
```

Safe, read-only: verifies Relay reachability, Hermes reachability, each Site's
MCP health endpoint, and that all referenced credentials are present. Performs
no edits and prints no secret values.

## Start / stop / restart / logs

```bash
sudo systemctl enable --now ulla-bella-adapter
sudo systemctl stop ulla-bella-adapter
sudo systemctl restart ulla-bella-adapter
systemctl status ulla-bella-adapter
journalctl -u ulla-bella-adapter -f
```

The service starts after the network is up, restarts on abnormal exit
(`Restart=on-failure`, `RestartSec=5`), and the Adapter reconnects automatically
with backoff after Relay restart or network blips.

## Update

```bash
sudo scripts/install-adapter.sh --binary /path/to/new/ulla-bella-adapter
sudo systemctl restart ulla-bella-adapter
```

Config and secrets are preserved (the installer never overwrites them).

## Uninstall

```bash
sudo systemctl disable --now ulla-bella-adapter
sudo rm -f /etc/systemd/system/ulla-bella-adapter.service /usr/local/bin/ulla-bella-adapter
sudo systemctl daemon-reload
```

This removes the service and binary but **preserves** `/etc/ulla-bella/`
(config + secrets). To fully purge:

```bash
sudo rm -rf /etc/ulla-bella          # explicit purge only
```

## YOOtheme MCP example (placeholders)

```yaml
sites:
  - site_id: site_example
    origin: https://example.test
    tool:
      type: yootheme-mcp
      endpoint: https://mcp.example.test/api/index.php/v1/yt-builder-mcp
      token_env: EXAMPLE_YTB_MCP_TOKEN
      host_header: example.test
      client_version: "2.3.1"
```

Set `EXAMPLE_YTB_MCP_TOKEN` in `adapter.env`. Use a `host_header` when the MCP
endpoint is tunneled or otherwise non-canonical for the origin.

## Version

```bash
ulla-bella-adapter version   # or --version
```

Prints version, commit and build date (injected at build time). Requires no
running Relay or Hermes.
