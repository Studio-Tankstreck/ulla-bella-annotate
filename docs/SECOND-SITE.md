# Ulla-Bella — Adding a second Site (operator dry run)

Task 14, Part 25. The product goal is "install on a couple of Sites". This
documents the exact current operator procedure to onboard an additional Site,
with every manual step and its pain point, as the basis for later
simplification.

Reference deployment (the live Task 13 stack on `ub-host`):

- Relay: `bin/relay`, CWD `~/ulla-bella`, DB
  `data/ulla-bella.db` (`RELAY_DB_FILE`), listening `127.0.0.1:8787`.
- Adapter: `ulla-bella-adapter --config ~/.config/ulla-bella/adapter.yaml`,
  agent `agent_pilot`.
- Hermes: `http://127.0.0.1:8642`.

## Steps

### 1. Register the Site in the Relay store

```sh
cd ~/ulla-bella
export RELAY_DB_FILE=$PWD/data/ulla-bella.db
bin/relay site create site_second --origin https://second.example.com --name "Second Example"
```

### 2. Grant the Site to the Adapter's agent

```sh
bin/relay agent grant-site agent_pilot site_second
```

### 3. Add the Site's MCP credential to the Adapter config

Edit `~/.config/ulla-bella/adapter.yaml` and append a `sites:` entry
with the Site's own `yootheme-mcp` endpoint, token, host header and client
version (each Site needs its own MCP credential — never share one):

```yaml
sites:
  - site_id: site_ub_joomla
    origin: https://joomla.example.test
    tool: { type: yootheme-mcp, endpoint: http://127.0.0.1:18780/..., token: ..., ... }
  - site_id: site_second
    origin: https://second.example.com
    tool: { type: yootheme-mcp, endpoint: http://127.0.0.1:18781/..., token: ..., ... }
```

The Site MCP credential is a **secret**: set it via the config's env-var
reference, not inline in the YAML (see `deploy/adapter.example.yaml`).

### 4. Validate the new config

```sh
ulla-bella-adapter --config ~/.config/ulla-bella/adapter.yaml validate
```

### 5. Restart the Adapter

```sh
systemctl restart ulla-bella-adapter     # or however the service is run
```

The Adapter re-reads the Site list on startup and (re)connects to the Relay as
`agent_pilot`.

### 6. Run the connectivity doctor

```sh
ulla-bella-adapter --config ~/.config/ulla-bella/adapter.yaml doctor
```

`doctor` performs safe, no-edit connectivity checks: Relay reachability, Hermes
reachability, and each Site's MCP liveness. It sends no credentials.

### 7. Create the `.ullabella` invite for the customer

```sh
bin/relay invite create site_second --out /tmp
# -> /tmp/second-example.ullabella
```

Send that file to the customer. They import it in the Ulla-Bella extension.

## Pain points (basis for later simplification)

1. **Three separate systems** — Relay CLI (SQLite), Adapter YAML, and the MCP
   endpoint — must be kept consistent by hand. A single "onboard site" command
   would remove most of this.
2. **Adapter restart is a hard requirement** — Sites are read at startup, so a
   new Site needs a service restart (brief downtime for the other Site).
3. **`doctor` ≠ full verification** — it proves connectivity, not that an edit
   round-trips. A real edit (or a dedicated "self-test edit" mode) is the only
   true confirmation.
4. **MCP credential provisioning is manual and per-Site** — no helper exists to
   mint/verify a YOOtheme MCP token for a new Site.
5. **No Site removal/migration story** — removing a Site means editing YAML +
   `relay site disable` + restart; there is no revocation of the device
   credential tied to that Site automatically.

## Not built (Task 14 scope)

No multi-Site management UI, no customer admin portal, no Adapter auto-updater,
no auto-reload of the Site list. These are future work.
