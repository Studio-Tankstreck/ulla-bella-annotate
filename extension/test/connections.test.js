"use strict";

// Unit tests for the connection model (src/connections.js): identity, the
// single-pairing migration, per-origin resolution, and the UI helpers.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const C = require(path.join(__dirname, "..", "src", "connections.js"));
const i18n = require(path.join(__dirname, "..", "src", "i18n.js"));

const RELAY_A = "https://relay.example.com";
const RELAY_B = "http://relay-b.test:8787";
const ORIGIN = "https://example.test";

function site(overrides) {
  return Object.assign(
    {
      deviceId: "dev_1",
      siteId: "site_alpha",
      origin: ORIGIN,
      relayUrl: RELAY_A,
      displayName: "Example Test",
      deviceCredential: "ubd_cred",
    },
    overrides || {}
  );
}

test("the connection id contains the relay, so two relays never share one", () => {
  const a = C.connectionId(RELAY_A, "site_alpha");
  const b = C.connectionId(RELAY_B, "site_alpha");
  assert.notEqual(a, b, "the same siteId on another relay is another connection");
  assert.ok(a.indexOf(RELAY_A) === 0);
  assert.equal(a, C.connectionId(RELAY_A + "/", "site_alpha"), "trailing slashes do not create duplicates");
  assert.equal(a, C.connectionId(RELAY_A, "site_alpha"), a, "deterministic (migration can re-run)");
});

test("migrating the single pairing is idempotent and keeps the credential", () => {
  const first = C.migrate({ site: site() });
  const ids = Object.keys(first.connections);
  assert.equal(ids.length, 1);
  const conn = first.connections[ids[0]];
  assert.equal(conn.siteId, "site_alpha");
  assert.equal(conn.relayUrl, RELAY_A);
  assert.equal(conn.deviceCredential, "ubd_cred");
  assert.equal(conn.migratedFrom, "site");
  assert.equal(first.needsMarker, true);

  // Run it again on the written result: same single connection, nothing new.
  const stored = {
    site: site(),
    connections: first.connections,
    activeByOrigin: first.activeByOrigin,
    "ub.migrated.connections": { at: 1, version: 1 },
  };
  const second = C.migrate(stored);
  assert.deepEqual(Object.keys(second.connections), ids);
  assert.equal(second.needsMarker, false, "the marker stops a re-import");
  assert.equal(second.changed, false);
});

test("a brand-new profile writes no marker, so a later legacy record still migrates", () => {
  const empty = C.migrate({});
  assert.equal(empty.needsMarker, false, "nothing to mark yet");
  assert.deepEqual(empty.connections, {});

  const later = C.migrate({ site: site() });
  assert.equal(Object.keys(later.connections).length, 1, "the legacy record is still imported");
});

test("a disconnected connection is not resurrected by re-running the migration", () => {
  const id = C.connectionId(RELAY_A, "site_alpha");
  const migrated = C.migrate({
    site: site(),
    removedConnections: { [id]: 123 },
    "ub.migrated.connections": { at: 1, version: 1 },
  });
  assert.deepEqual(migrated.connections, {});
});

test("resolving a page never guesses between two connections for one origin", () => {
  const one = C.migrate({ site: site() });
  const single = C.resolveForOrigin(one.connections, one.activeByOrigin, ORIGIN);
  assert.ok(single.connection, "a single connection is used directly");
  assert.equal(single.ambiguous, false);

  const a = C.normalizeConnection(site());
  const b = C.normalizeConnection(site({ relayUrl: RELAY_B, displayName: "Other relay" }));
  const map = { [a.connectionId]: a, [b.connectionId]: b };

  const ambiguous = C.resolveForOrigin(map, {}, ORIGIN);
  assert.equal(ambiguous.connection, null);
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.candidates.length, 2);

  const chosen = C.resolveForOrigin(map, { [ORIGIN]: b.connectionId }, ORIGIN);
  assert.equal(chosen.connection.connectionId, b.connectionId);
  assert.equal(chosen.chosenBy, "explicit");
  assert.equal(chosen.candidates.length, 2, "the chooser stays available to switch explicitly");

  // A choice that belongs to another origin is ignored.
  const wrongOrigin = C.resolveForOrigin(map, { "https://other.test": b.connectionId }, ORIGIN);
  assert.equal(wrongOrigin.connection, null);
  assert.equal(wrongOrigin.ambiguous, true);

  // A page nobody serves.
  const none = C.resolveForOrigin(map, {}, "https://unknown.test");
  assert.equal(none.connection, null);
  assert.equal(none.ambiguous, false);
});

test("upsert adds a connection without touching the others, keeping a chosen agent", () => {
  const a = C.normalizeConnection(site());
  let map = C.upsert({}, a);
  map = C.withAgent(map, a.connectionId, "agent_pilot", "Pilot");

  const b = C.normalizeConnection(site({ siteId: "site_beta", origin: "https://beta.test", displayName: "Beta" }));
  map = C.upsert(map, b);
  assert.deepEqual(Object.keys(map).sort(), [a.connectionId, b.connectionId].sort());
  assert.equal(map[a.connectionId].agentId, "agent_pilot", "the other connection keeps its agent");
  assert.equal(map[a.connectionId].deviceCredential, "ubd_cred");

  // Re-pairing the same connection replaces the credential but keeps the agent.
  const repaired = C.normalizeConnection(site({ deviceCredential: "ubd_new" }));
  map = C.upsert(map, repaired);
  assert.equal(map[a.connectionId].deviceCredential, "ubd_new");
  assert.equal(map[a.connectionId].agentId, "agent_pilot");
  assert.deepEqual(Object.keys(map).sort(), [a.connectionId, b.connectionId].sort());
});

test("without() removes exactly one connection and its active pointer", () => {
  const a = C.normalizeConnection(site());
  const b = C.normalizeConnection(site({ siteId: "site_beta", origin: "https://beta.test" }));
  const map = { [a.connectionId]: a, [b.connectionId]: b };
  const active = { [ORIGIN]: a.connectionId, "https://beta.test": b.connectionId };

  const after = C.without(map, active, a.connectionId);
  assert.deepEqual(Object.keys(after.connections), [b.connectionId]);
  assert.equal(after.activeByOrigin[ORIGIN], undefined);
  assert.equal(after.activeByOrigin["https://beta.test"], b.connectionId, "the other site keeps its choice");
});

test("the relay label is only needed when a siteId appears twice", () => {
  const a = C.normalizeConnection(site());
  const sameSiteOtherRelay = C.normalizeConnection(site({ relayUrl: RELAY_B, displayName: "Other" }));
  const otherSite = C.normalizeConnection(site({ siteId: "site_beta", origin: "https://beta.test" }));

  assert.equal(C.needsRelayLabel({ [a.connectionId]: a }), false);
  assert.equal(
    C.needsRelayLabel({ [a.connectionId]: a, [otherSite.connectionId]: otherSite }),
    false,
    "different siteIds do not need the relay to be told apart"
  );
  assert.equal(C.needsRelayLabel({ [a.connectionId]: a, [sameSiteOtherRelay.connectionId]: sameSiteOtherRelay }), true);
});

test("status mapping distinguishes unreachable from unknown", () => {
  assert.equal(C.statusFromProbe(null), "unknown");
  assert.equal(C.statusFromProbe({ ok: true, agents: [] }), "online");
  assert.equal(C.statusFromProbe({ ok: false, error: { code: "relay_unreachable" } }), "unavailable");
  assert.equal(C.statusFromProbe({ ok: false, error: { code: "timeout" } }), "unavailable");
  assert.equal(C.statusFromProbe({ ok: false, error: { code: "invalid_credential" } }), "unauthorized");
  assert.equal(C.statusFromProbe({ ok: false, error: { code: "device_out_of_scope" } }), "unauthorized");
  assert.equal(C.statusFromProbe({ ok: false, error: { code: "weird" } }), "unknown");

  assert.match(C.statusLabel("online", i18n.t), /Connected/);
  assert.match(C.statusLabel("unavailable", i18n.t), /unreachable/i);
  assert.match(C.statusLabel("unauthorized", i18n.t), /Not authorized/i);
  assert.match(C.statusLabel("unknown", i18n.t), /unknown/i);
});

test("agent options keep a chosen agent that the relay no longer offers", () => {
  const list = C.agentOptions(
    [
      { agentId: "agent_a", name: "Agent A", connected: true },
      { agentId: "agent_b", name: "Agent B", connected: false },
    ],
    "agent_c",
    i18n.t
  );
  assert.equal(list.length, 3);
  const ghost = list.find((a) => a.agentId === "agent_c");
  assert.ok(ghost, "the previously chosen agent stays visible");
  assert.match(ghost.name, /no longer offered/);
  assert.equal(list.find((a) => a.agentId === "agent_b").connected, false);
});
