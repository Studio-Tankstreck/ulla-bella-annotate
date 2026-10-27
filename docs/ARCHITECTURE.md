# Ulla-Bella Annotate — Architecture

**Status:** implemented (Tasks 06–14) · **Scope:** current 2.1 architecture · **Version:** `1`

---

## 1. Goal

Define the smallest coherent, **agent-agnostic** architecture and protocol needed to
build the first Ulla-Bella Annotate vertical slice:

> Select one element in Chrome, write "Change this heading to Our Services", and get a
> **verified** website change back through the Relay to Chrome showing `Done`.

This document is concrete enough for Task 06 to begin implementation without reopening
fundamental protocol decisions. It is **design only** — no implementation.

---

## 2. Architecture

Website editing is a **separate product path** from LibreChat. LibreChat remains the
normal chat interface and is **not** part of the annotation transport path.

```
Chrome Extension
      |
      | HTTPS (browser-initiated)
      v
Ulla-Bella Relay
      ^
      | outbound persistent connection (adapter-initiated)
      |
Hermes Adapter / Plugin
      |
      v
Hermes
      |
      v
Website tool / CMS / MCP
```

**Core principle:** the protocol is **agent-agnostic**. Hermes is the first adapter and
the only adapter in the MVP. No Hermes-specific concept (API URLs, provider, model,
tool names, credentials) may leak into the core protocol.

---

## 3. Core objects

Seven protocol concepts. Not all need their own persistent table in the first
implementation; the table below states protocol meaning and persistence intent.

| Object | Purpose | Persists |
|---|---|---|
| `Site` | Authorization boundary for editing one website origin | Yes (Relay) |
| `Agent` | The adapter/agent responsible for a set of Sites (routing target) | Yes (Relay) |
| `Device` | One paired browser/extension instance, scoped to granted Sites | Yes (Relay) |
| `Invite` | Ephemeral onboarding bootstrap (the `.ullabella` file) | No — yields a Device |
| `Annotation` | "This thing on this page → this change" | Yes (inside a Job) |
| `Job` | Unit of work: one or more Annotations from one Device for one Site | Yes (Relay, until terminal + TTL) |
| `Result` | Agent's outcome for a Job (status + optional verification) | Yes (attached to Job) |

### 3.1 Site

```
siteId        required   string   UUID (Relay-issued)
origin        required   string   e.g. "https://example.test"  — the security boundary
displayName   optional   string   human label
```

- **Created by:** Relay (operator/onboarding).
- **Consumed by:** Relay (routing + authorization), Adapter (site policy), Device (scope display).
- **Boundary:** a credential for one Site must **not** implicitly authorize another
  Site. CMS/MCP/SSH credentials are **never** part of the Site object sent to Chrome —
  they remain agent-side.

### 3.2 Agent

```
agentId       required   string   UUID (Relay-issued)
displayName   optional   string
sites[]       required   string[] siteIds this agent is responsible for
```

- **Created by:** Relay (adapter registration).
- **Consumed by:** Relay (routing only). **Never exposed to Chrome.**
- **Boundary:** Chrome only needs to know *whether* a Site has a connected agent, never
  *how* (no Hermes URLs, provider, model, SSH/CMS/MCP credentials).

### 3.3 Device

```
deviceId       required   string   UUID (Relay-issued at pairing)
allowedSiteIds required   string[] scope — which Sites this device may act on
createdAt      required   string   ISO-8601 UTC
```

- **Created by:** Relay (when an Invite is redeemed).
- **Consumed by:** Relay (authorization), Chrome (its own identity).
- **Boundary:** a Device operates **only** within `allowedSiteIds`. The credential
  identity (token) is a runtime secret held by Relay; auth cryptography is deferred.

### 3.4 Invite

```
relayUrl       required   string   Relay base URL
pairingToken   required   string   single-use / short-lived
siteId         optional   string   site reference (may be omitted for generic invite)
displayName   optional   string
```

- **Created by:** Relay/operator on demand; exported as `lighthouse.ullabella`.
- **Consumed by:** Chrome (import) and Relay (redeem).
- **Must NOT contain long-lived secrets.** Redeeming an Invite mints a long-lived
  Device (deviceId + allowedSiteIds + credential) and invalidates the `pairingToken`.
  Signing/encryption deferred.

### 3.5 Annotation

The most important payload: "the user is referring to **this thing** on **this page**
and wants **this change**."

```
annotationId   required   string   client-generated UUID
instruction    required   string   natural-language change request
target         required   object   see below
context        optional   object   nearby text / page section
```

`target`:

```
url            required   string   page URL — the durable identity
pageTitle      hint       string
elementType    hint       string   e.g. "h1", "img", "button"
visibleText    hint       string   text the element currently shows
selector       hint       string   CSS selector
domPath        hint       string   element path / attributes
rect           hint       object   bounding rectangle {x,y,width,height}
```

- **Required:** `annotationId`, `instruction`, `target.url`.
- **Best-effort hints:** everything else — the agent uses them to *find* the element.
- **Never sole source of truth:** `selector`, `domPath`, and `rect` — the DOM is
  mutable; the agent must resolve the element from `url` + `instruction` + `visibleText`
  and treat structural hints as advisory.
- **Screenshot/crop:** deferred to later; the shape above does not require it.

### 3.6 Job

A Job and an Annotation are **not** the same object. A Job is the unit of work; it
naturally carries multiple annotations.

```
jobId          required   string   client-generated UUID
siteId         required   string
deviceId       required   string
agentId        optional   string   the agent the user chose (≤ 128 chars)
annotations[]  required   Annotation[]   (≥ 1; up to 8 per round)
createdAt      required   string   ISO-8601 UTC
context        optional   object   { session } — job-wide context for every annotation
```

- **`agentId`** (added in sessions etapp 3) is the user's per-site agent choice. The Relay
  honours it only through the `agent_sites` grant: not granted → `403 agent_not_allowed`,
  granted but not connected → `503 agent_unavailable`. It never falls back to another agent.
  Absent → the historical rule (first connected agent granted for the site). The adapter
  that receives the job decides which Hermes instance and which site workspace performs the
  edit, so the choice really changes the executor. See [`SESSIONS.md`](SESSIONS.md) §8.1.

- **`context.session`** (added in sessions etapp 2) is the user's session description: shared
  context for all annotations of the round. It is never a task of its own and is never
  repeated per annotation. The field is optional and the object is closed, so jobs submitted
  before it existed are unchanged — but a Relay reads `job.schema.json` at startup, so the
  schema must be deployed (relay restart) before a client sends it. See
  [`SESSIONS.md`](SESSIONS.md) §7.3.
- **Excluded:** billing, user plans, model selection, LLM temperature, Hermes
  configuration, CMS credentials.

### 3.7 Result

The agent-side response. `status` carries lifecycle state; terminal states are
`done` / `error`.

```
jobId               required   string
status              required   enum     accepted | working | done | error
summary             optional   string   concise human-readable text
verification        optional-on-done   { status: "passed" | "failed", summary }
error               required-on-error  { code, message }
annotationResults   optional   AnnotationResult[]   per-annotation outcome (batch)
activity            optional   object      live snapshot { kind, activityAt, checkedAt } carried on a non-terminal `working` Result
```

`annotationResult` = `{ annotationId, status: "done"|"error", summary?,
verification?, error? }` — one entry per submitted `annotationId`, in job order.

- **Single annotation** (back-compat): `done` requires `verification.status ===
  "passed"`; a verification failure is reported as `error` — never success.
- **Batch** (2–8 annotations): job `status: "done"` means the round was
  *processed*; each annotation's granular outcome lives in `annotationResults[]`
  (a mix of `done` and `error` is valid partial success). A missing/unclear entry
  is reported as `error` (code `no_result` or `verification_failed`) — never
  `done`. The adapter's deterministic postcondition (old visible text gone) is the
  final authority over the agent's self-report.
- Status events (`accepted`, `working`) and the final `done`/`error` use the **same
  envelope**; `working` is optional (an adapter may go straight to `done`).

---

## 4. Protocol envelope

Every message shares a tiny envelope. Versioning is carried here on every message.

```
schemaVersion   required   string   "1"
messageType     required   enum     job | result
id              required   string   message UUID (for correlation/debugging)
timestamp       required   string   ISO-8601 UTC
payload         required   object   Job or Result
```

The **first protocol version is `"1"`**, carried in `schemaVersion`.

---

## 5. Job lifecycle

Minimal state machine. No queueing in the MVP.

```
        Chrome              Relay                 Adapter
          │  create Job       │                      │
          │ ─────────────────>│  no connected agent  │
          │                   │  ── error(agent_unavailable)
          │                   │  connected agent     │
          │                   │  ── accepted ──────> │
          │                   │                      │  ── working (optional)
          │                   │                      │  ── done | error ──> Relay
          │  <─ result ─────── │                      │
```

| State | Owner of transition | Meaning |
|---|---|---|
| `accepted` | Relay | Job received and forwarded to a connected adapter |
| `working` | Adapter | Execution started (optional) — may span minutes (durable async run) |
| `done` | Adapter | Verified success — terminal |
| `error` | Relay or Adapter | Any failure — terminal |

**Chrome displays:** `accepted`/`working` → spinner; while `working`, a live
"Activity: <label>" line and "Last agent activity: Ns ago" when the Result carries an
`activity` snapshot (else a neutral "Agent activity unavailable"); `done` → "Done" (+
optional summary); `error` → human-readable message.

---

## 6. Security boundaries

Authority, without full cryptography.

### Browser (extension)

**May:** create jobs for granted Sites; read status/results for its own jobs.

**May NOT:** obtain Hermes/CMS credentials; change agent-side site policy; edit another
Site.

Local state: one *session document* per connected Site + page (queue, description,
submitted round, removal tombstones), keyed by `siteId` + page so Sites never mix — see
[`SESSIONS.md`](SESSIONS.md). This is extension-local state, not part of Protocol V1.

### Relay

**Responsible for:** authentication, routing (siteId → responsible Agent), enforcing the
Site/Device relationship. **Does not need CMS credentials.**

### Hermes Adapter

**Responsible for:** site-side policy, agent/tool access, deciding whether requested work
falls within allowed website-editing scope. Holds agent-side credentials (CMS/MCP/SSH).

---

## 7. Site policy boundary

The **Job** says *what* the user wants changed. The **adapter** decides *whether* the
agent is allowed to do it and *how*. This policy matrix is **not** encoded into the
browser protocol.

- **Autonomous (in scope):** text changes, headings, images, ordinary layout, sections,
  normal pages, mobile layout.
- **Outside scope:** DNS, secrets, SSH credentials, server configuration, admin/user
  management, destructive bulk deletion, security-policy changes, anything outside the
  configured Site/workspace.

---

## 8. Verification contract

```
execute → read/inspect result → verify → report done
```

The browser does **not** approve every change; the agent verifies its own result. A
Result is `done` **only** when `verification.status === "passed"` and a human-readable
`summary` is present. Verification mechanisms are CMS-specific and not part of the
protocol.

---

## 9. First vertical slice

```
1.  User opens a configured test website in Chrome.
2.  User activates Ulla-Bella annotation mode.
3.  User selects one visible element.
4.  User writes "Change this heading to Our Services".
5.  Extension sends one Job.
6.  Relay routes it to the connected agent for that Site.
7.  Hermes receives the Job.
8.  Hermes uses the website's configured editing capability.
9.  The heading is changed.
10. Hermes verifies the heading actually changed.
11. Result travels back through Relay.
12. Chrome shows "Done".
```

**Acceptance test (Task 06):** on `https://example.test/services`, change the H1
"Tjänster" → "Our Services", receive a `done` Result with
`verification.status = "passed"`, and see "Done" in Chrome.

---

## 10. Example payloads

Scenario: `https://example.test/services`, existing H1 `Tjänster`, instruction "Change
this heading to Our Services". Only V1 fields shown.

**Site**

```json
{
  "siteId": "site_01j7x9k2m",
  "origin": "https://example.test",
  "displayName": "Example Test"
}
```

**Device**

```json
{
  "deviceId": "dev_01j7xa1b3",
  "allowedSiteIds": ["site_01j7x9k2m"],
  "createdAt": "2026-10-07T08:00:00Z"
}
```

**Job (envelope + payload)**

```json
{
  "schemaVersion": "1",
  "messageType": "job",
  "id": "msg_01j7xb4c5",
  "timestamp": "2026-10-07T08:00:01Z",
  "payload": {
    "jobId": "job_01j7xb4c5",
    "siteId": "site_01j7x9k2m",
    "deviceId": "dev_01j7xa1b3",
    "createdAt": "2026-10-07T08:00:01Z",
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

**Result (done)**

```json
{
  "schemaVersion": "1",
  "messageType": "result",
  "id": "msg_01j7xb9d7",
  "timestamp": "2026-10-07T08:00:12Z",
  "payload": {
    "jobId": "job_01j7xb4c5",
    "status": "done",
    "summary": "H1 now reads 'Our Services'",
    "verification": { "status": "passed", "summary": "H1 now reads 'Our Services'" }
  }
}
```

**Result (error — agent offline)**

```json
{
  "schemaVersion": "1",
  "messageType": "result",
  "id": "msg_01j7xb9e8",
  "timestamp": "2026-10-07T08:00:02Z",
  "payload": {
    "jobId": "job_01j7xb4c5",
    "status": "error",
    "error": { "code": "agent_unavailable", "message": "No agent is connected for this site right now." }
  }
}
```

---

## 11. Sequence diagram

```
Chrome          Relay           Hermes Adapter      Hermes       Website
   |               |                 |                |             |
   |--- Job ------>|                 |                |             |
   |               |  route by siteId                |             |
   |               |--- Job ------->|                |             |
   |<-- accepted --|                 |--- prompt ---->|             |
   |               |                 |                |--- edit --->|
   |               |                 |                |<-- verify --|
   |               |<-- done -------|                |             |
   |<-- Result -----|                 |                |             |
   |   "Done"       |                 |                |             |
```

The Relay never opens an inbound connection to the adapter; the adapter's **outbound**
connection is what carries the Job and returns the Result.

---

## 12. Failure behavior (MVP)

| Failure | Behavior |
|---|---|
| Agent offline | Relay immediately returns `error` with code `agent_unavailable` (no queue) |
| Website edit fails | `error` with a safe human-readable message |
| Verification fails | `error` (code `verification_failed`) — never `done` |
| Browser disconnects | Result is retrievable by `jobId` when it reconnects (Relay stores the terminal Result) |
| Adapter restart mid-job | The Adapter persists a `jobId`→run mapping and, on reconnect, resumes the in-flight run and re-delivers the Result (never re-runs it) |
| Relay restart mid-job | `working` jobs are left for the Adapter to resume; `accepted` jobs (adapter never confirmed) are interrupted |

The Adapter executes each job as a **durable asynchronous run** (submit → poll → final
result) rather than one blocking call, so jobs that take minutes survive restarts and
disconnects. This is an adapter-internal detail: Protocol V1 (envelope, Job, Result,
lifecycle statuses) is unchanged. See `docs/HERMES-ASYNC.md`.

---

## 13. Explicit non-goals

Dashboard · billing · Free/Pro enforcement · agency features · SEO audit ·
accessibility audit · undo · version history · screenshots (not required for V1) ·
Safari · mobile · multi-user collaboration · Codex/Claude/generic adapters ·
sophisticated queues · distributed workers · HA · analytics · notifications · approval
workflows for normal website edits.

---

## 14. Repository / component boundaries

**One monorepo** for the MVP. Shared protocol definitions live in `protocol/` as the
single source of truth (language-agnostic JSON Schema + this document), so the Relay,
adapter, and extension all reference one canonical definition.

```
ulla-bella-annotate/
  protocol/          # JSON Schema (job, result, envelope) + docs — shared source of truth
  relay/             # routing/authn service
  hermes-adapter/    # Hermes adapter (outbound connection to Relay)
  extension/         # Chrome extension
  docs/              # this document and later ADRs
```

Rationale: one repo avoids cross-repo versioning overhead for a small project; it can
split into separate repos later without protocol churn.

---

## 15. Open questions (deferred)

- Result delivery to Chrome: HTTP polling vs SSE vs WSS (MVP: poll by `jobId`).
- Device credential token format / cryptography (conceptual boundary only for now).
- Adapter↔Relay connection mechanism (WSS vs long-poll) and reconnect.
- Invite file signing/encryption.
- Screenshot/crop targeting.
- Undo / version history.

---

## 16. Decision summary

| Decision | Choice |
|---|---|
| Site identity | `siteId` + `origin`; `origin` is the authorization boundary |
| Job vs Annotation | Separate — `Job.annotations[]` (1–8 per round) |
| Routing | Relay routes by `siteId` → responsible `Agent` (owns `sites[]`) |
| Policy location | Adapter (not browser, not Relay) |
| Result semantics | `accepted`/`working`/`done`/`error`; `done` ⇒ `verification.status = "passed"` |
| Envelope & version | Shared envelope; `schemaVersion: "1"` on every message |
| Transport | Chrome→Relay HTTPS; Adapter→Relay outbound persistent connection |
| Agent offline | Immediate `error(agent_unavailable)` — no queue in MVP |
| Target identity | `url` durable; `selector`/`rect`/`domPath` are hints, never sole source of truth |
| Repo | Single monorepo, shared `protocol/` definitions |

---

## 17. Recommended Task 06

Prove the protocol end-to-end over the wire with the **fewest** components — no Chrome
extension, no Hermes, no CMS yet:

1. Author `protocol/` JSON Schemas (envelope, Job, Result).
2. **Relay stub:** HTTPS endpoint to accept a Job; adapter registry keyed by `siteId`;
   an outbound-connection listener for adapters.
3. **Adapter stub:** opens an outbound connection to Relay, receives the Job, and returns
   a hardcoded `done` Result with `verification.status = "passed"`.
4. **Scripted client** (curl/`node`, not the full extension) posts a Job and receives the
   Result.

This exercises `Chrome → Relay → Adapter → Relay → Chrome` and the versioned envelope
before any real agent or website edit is wired in.

---

## 18. Multi-Site / Multi-Agent (implemented in sessions etapp 3)

One Chrome Extension manages several connected Sites, each mapped to its own Agent or left
on "automatic". The data model always supported it; etapp 3 built the extension side and
the routing guarantee:

- **Connection identity** is `<relay origin>|<siteId>`, so two Relays hosting the same
  `siteId` are distinct connections with distinct credentials, sessions and jobs.
- **Sessions** are keyed by connection: `ub.session.<connectionId>|<pageId>`. The etapp-1
  writer queue is per key, unchanged.
- **Per-origin resolution**: a tab uses the connection for its own origin; with several
  candidates the user must choose, and the popup always offers the chooser. Local sessions,
  queues and results never cross connections.
- **Recipient pinning**: a submitted Job snapshots `connectionId`, `relayUrl`, credential,
  `sessionId`, `agentId` and the session description; polling uses that snapshot.
- **Agent choice is server-checked**: `GET /v1/sites/{siteId}/agents` lists only granted
  agents with a live `connected` flag; `payload.agentId` is validated against `agent_sites`
  and never silently replaced.
- **Migration** from the single `site` record is idempotent and keeps the pairing,
  credential, session queue, description and intro status.

Details, compatibility and verification: [`SESSIONS.md`](SESSIONS.md) §8.
