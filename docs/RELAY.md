# Connect your own Relay

The Relay is the one component you must host yourself: it authenticates browsers and
agents, decides which agent may edit which site, and stores job state. This page covers
running it, wiring the extension to it, and doing it safely.

Related: [`ADAPTER_INSTALL.md`](ADAPTER_INSTALL.md) (the agent side),
[`OPERATIONS.md`](OPERATIONS.md) (day-to-day operation), [`ULLABELLA_FILE.md`](ULLABELLA_FILE.md)
(the file a browser imports).

## 1. Run the Relay

```bash
export PATH="$HOME/.local/go/bin:$PATH"
go build -o bin/relay ./relay

mkdir -p data
RELAY_ADDR=127.0.0.1:8787 \
RELAY_DB_FILE="$PWD/data/ulla-bella.db" \
RELAY_PUBLIC_URL=https://relay.example.com \
SCHEMA_DIR=protocol \
./bin/relay
```

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_ADDR` | `127.0.0.1:8787` | Listen address. Use `0.0.0.0:8787` only behind a proxy or on a trusted network. |
| `RELAY_DB_FILE` | `ulla-bella.db` | SQLite database (WAL). Contains sites, agents, grants, invites, devices, jobs. |
| `RELAY_PUBLIC_URL` | `http://127.0.0.1:8787` | The URL written into `.ullabella` invites. It must be reachable **from the browser**, not from the Relay. |
| `SCHEMA_DIR` | `protocol` | Where the protocol schemas are read from at startup. Jobs and results are validated against them. |
| `TRUST_PROXY` | unset | Set to `1` when a reverse proxy fronts the Relay, so rate limiting keys on `X-Forwarded-For`. |

Health: `curl -fsS http://127.0.0.1:8787/healthz` and `/readyz` (the second also checks the
database and migrations). Neither leaks configuration.

## 2. Define what may be edited

All administration is the same binary against the same database — it works while the Relay
runs.

```bash
# a site: the origin the browser will edit, and a display name
./bin/relay site create site_example --origin https://example.com --name "Example"

# an agent: identity for one Adapter (the credential is printed exactly once)
./bin/relay agent create agent_main --name "Main agent"

# authorise that agent for that site — an agent only ever sees granted sites
./bin/relay agent grant-site agent_main site_example

# a single-use invite for a browser; writes site_example.ullabella into --out
RELAY_PUBLIC_URL=https://relay.example.com ./bin/relay invite create site_example --out .
```

```bash
./bin/relay site list
./bin/relay agent list
./bin/relay device list
./bin/relay device revoke dev_…      # a lost browser
```

There is no admin UI by design: the operator surface is the CLI plus the database.

## 3. Point the extension at it

Two ways, and the difference matters for what the extension is allowed to talk to.

### Portable build (what the release ZIP is)

No Relay origin is compiled in. `manifest.json` ships `host_permissions: []` and the
pairing allowlist is empty. When you import a `.ullabella` file, the popup asks the browser
for host access to the Relay origin named in that file — one prompt per Relay — and the
service worker accepts that origin only while the permission is held. Decline the prompt
and nothing is paired.

Consequences:

- Anyone can point their own installation at their own Relay without rebuilding.
- A file on its own never widens the extension's network access.
- Use `https://` for the Relay URL in a real deployment (an `http://` origin works only
  where Chrome allows it, typically `localhost`).

Build it yourself with:

```bash
RELAY_PORTABLE=1 ./scripts/package-extension.sh
```

### Canonical build

One origin is baked in at build time and no prompt is needed:

```bash
RELAY_ORIGIN=https://relay.example.com ./scripts/package-extension.sh
```

The packaging script writes that origin into `manifest.json`'s `host_permissions` **and**
into the pairing allowlist (`src/relay-policy.js`), and fails the build if the two disagree
or if a dev origin, a secret or a leftover placeholder is found. A canonical build refuses
any other Relay — including one the user granted permission for.

## 4. Put it behind TLS

The Relay speaks plain HTTP and WebSocket. For anything reachable from outside a trusted
network, terminate TLS in front of it (Caddy, nginx, Traefik, a Cloudflare tunnel — any of
them) and forward both the HTTP API and `/v1/ws`. Set `RELAY_PUBLIC_URL` to the public
`https://` URL when minting invites, and `TRUST_PROXY=1` so rate limits key on the real
client address.

Never expose the Hermes port. The Adapter talks to Hermes over loopback and connects
outbound to the Relay; only the Relay needs to be reachable.

## 5. What the Relay enforces

- Device requests need a device credential for the site being submitted
  (`403 device_out_of_scope`, `403 url_out_of_origin`), results are readable only by the
  device that owns the job, and a disabled site answers `403 site_disabled`.
- An agent may only be routed jobs for sites it was granted (`403 agent_not_allowed`,
  `503 agent_unavailable` — never a silent fallback to another agent).
- Rate limits: pairing 5/min, jobs 60/min, answering `429` with `Retry-After`. Bodies are
  capped (job 1 MiB, pairing 8 KiB, WebSocket frame 1 MiB).
- Job ids are idempotent: the same payload from the same device returns the stored result
  instead of running twice; a different payload under a used id is `409 job_conflict`.
- Credentials are stored as SHA-256 hashes; access logs never print headers, bodies or
  credentials.

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Extension says it cannot reach the service | Relay not running, wrong `RELAY_PUBLIC_URL` in the invite, TLS not trusted, or a firewall between browser and Relay. Check `curl -fsS <relay>/healthz` from the browser's machine. |
| Pairing refused with "unrecognized Ulla-Bella service" | Portable build: the Relay permission prompt was declined. Canonical build: the file names an origin other than the packaged one. |
| Invite fails with `invite_expired` / `invite_already_used` | Invites are single-use and short-lived; mint a new one. |
| Jobs sit at `accepted` | The agent is not connected (`relay agent list` shows liveness in the Adapter log: `adapter: registered agentId=… sites=[…]`). |
| Jobs fail with `agent_unavailable` | The site is granted to an agent the Adapter has no config for, or no agent is connected. |
