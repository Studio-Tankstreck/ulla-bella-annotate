"use strict";

// Service-worker settings tests: the connection set is one storage map, so every
// settings change is a read-modify-write. These tests overlap the real handlers
// and prove that no change is lost, and that a reload sees all of them.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { makeChromeShim, loadBackground, reply } = require("./support/worker-shim");
const C = require(path.join(__dirname, "..", "src", "connections.js"));

const RELAY = "http://relay-a.test:8787";
const RELAY_B = "http://relay-b.test:8787";

function conn(over) {
  return C.normalizeConnection(
    Object.assign(
      {
        relayUrl: RELAY,
        siteId: "site_a",
        deviceId: "dev_a",
        origin: "https://a.test",
        displayName: "Site A",
        deviceCredential: "ubd_a",
      },
      over || {}
    )
  );
}

function seedOf(list) {
  const map = {};
  for (const raw of list) map[raw.connectionId] = raw;
  return { connections: map, "ub.migrated.connections": { at: 1, version: 1 } };
}

test("two concurrent agent picks for different sites both survive", async () => {
  const a = conn();
  const b = conn({ siteId: "site_b", deviceId: "dev_b", origin: "https://b.test", displayName: "Site B" });
  const shim = makeChromeShim(seedOf([a, b]));
  loadBackground(shim);

  const [ra, rb] = await Promise.all([
    reply(shim, { type: "setAgent", connectionId: a.connectionId, agentId: "agent-a", agentName: "Agent A" }),
    reply(shim, { type: "setAgent", connectionId: b.connectionId, agentId: "agent-b", agentName: "Agent B" }),
  ]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.equal(shim._storage.connections[a.connectionId].agentId, "agent-a");
  assert.equal(shim._storage.connections[b.connectionId].agentId, "agent-b");
});

test("four concurrent agent picks all land", async () => {
  const list = [];
  for (let i = 0; i < 4; i++) {
    list.push(conn({ siteId: "site_" + i, deviceId: "dev_" + i, origin: "https://s" + i + ".test" }));
  }
  const shim = makeChromeShim(seedOf(list));
  loadBackground(shim);

  await Promise.all(
    list.map((c, i) => reply(shim, { type: "setAgent", connectionId: c.connectionId, agentId: "agent-" + i }))
  );
  for (let i = 0; i < 4; i++) {
    assert.equal(shim._storage.connections[list[i].connectionId].agentId, "agent-" + i, "pick " + i);
  }
});

test("two concurrent active choices for different origins both survive", async () => {
  const a = conn();
  const b = conn({ siteId: "site_b", deviceId: "dev_b", origin: "https://b.test", displayName: "Site B" });
  const shim = makeChromeShim(seedOf([a, b]));
  loadBackground(shim);

  await Promise.all([
    reply(shim, { type: "setActiveConnection", origin: "https://a.test", connectionId: a.connectionId }),
    reply(shim, { type: "setActiveConnection", origin: "https://b.test", connectionId: b.connectionId }),
  ]);
  assert.equal(shim._storage.activeByOrigin["https://a.test"], a.connectionId);
  assert.equal(shim._storage.activeByOrigin["https://b.test"], b.connectionId);
});

test("an agent pick racing a disconnect keeps both changes", async () => {
  const a = conn();
  const b = conn({ siteId: "site_b", deviceId: "dev_b", origin: "https://b.test", displayName: "Site B" });
  const shim = makeChromeShim(seedOf([a, b]));
  loadBackground(shim);

  const [pick, gone] = await Promise.all([
    reply(shim, { type: "setAgent", connectionId: a.connectionId, agentId: "agent-a" }),
    reply(shim, { type: "disconnect", connectionId: b.connectionId }),
  ]);
  assert.equal(pick.ok, true);
  assert.equal(gone.ok, true);
  assert.equal(shim._storage.connections[a.connectionId].agentId, "agent-a", "the pick survived");
  assert.equal(shim._storage.connections[b.connectionId], undefined, "the disconnect applied");
  assert.ok(shim._storage.removedConnections[b.connectionId], "and left its tombstone");
});

test("an agent pick racing an import keeps both changes", async () => {
  const a = conn();
  const shim = makeChromeShim(seedOf([a]));
  loadBackground(shim);
  // The policy list is the same array object the module exports; the packaged
  // build substitutes the real Relay origin here.
  globalThis.UllaBellaRelayPolicy.ALLOWED_RELAY_ORIGINS.push(RELAY);

  // The import path (redeemAndStore) needs the Relay; a test-only pair response
  // keeps this about the storage write, not about pairing.
  const incoming = conn({ siteId: "site_new", deviceId: "dev_n", origin: "https://new.test", displayName: "New" });
  shim._fetch = async function (url) {
    shim._fetches.push({ url: url });
    if (url.indexOf("/v1/pair") !== -1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          deviceId: incoming.deviceId,
          siteId: incoming.siteId,
          origin: incoming.origin,
          displayName: incoming.displayName,
          deviceCredential: incoming.deviceCredential,
        }),
      };
    }
    return { ok: false, status: 599, json: async () => ({}) };
  };
  globalThis.fetch = shim._fetch;

  const [pick, imported] = await Promise.all([
    reply(shim, { type: "setAgent", connectionId: a.connectionId, agentId: "agent-a" }),
    reply(shim, { type: "redeemInvite", relayUrl: RELAY, invite: "inv_test" }),
  ]);
  assert.equal(pick.ok, true);
  assert.equal(imported.ok, true);
  assert.equal(shim._storage.connections[a.connectionId].agentId, "agent-a", "the pick survived the import");
  assert.ok(shim._storage.connections[incoming.connectionId], "and the new site was added");
  assert.equal(Object.keys(shim._storage.connections).length, 2, "nothing was replaced");
});

test("everything survives a worker reload", async () => {
  const a = conn();
  const b = conn({ siteId: "site_b", deviceId: "dev_b", origin: "https://b.test", displayName: "Site B" });
  const shim = makeChromeShim(seedOf([a, b]));
  loadBackground(shim);

  await Promise.all([
    reply(shim, { type: "setAgent", connectionId: a.connectionId, agentId: "agent-a", agentName: "Agent A" }),
    reply(shim, { type: "setActiveConnection", origin: "https://b.test", connectionId: b.connectionId }),
    reply(shim, { type: "setAgent", connectionId: b.connectionId, agentId: "agent-b" }),
  ]);

  // A fresh worker instance over the same storage (MV3 restart).
  const reloaded = makeChromeShim(shim._storage);
  loadBackground(reloaded);
  const state = await reply(reloaded, { type: "getConnections" });
  assert.equal(state.connections[a.connectionId].agentId, "agent-a");
  assert.equal(state.connections[b.connectionId].agentId, "agent-b");
  assert.equal(state.activeByOrigin["https://b.test"], b.connectionId);
  assert.equal(Object.keys(state.connections).length, 2);
});

test("a settings write on a pre-etapp-3 profile migrates and keeps the change", async () => {
  // Only the legacy `site` record exists: the connection set is produced by the
  // migration, and the same write must also carry the user's choice.
  const legacy = {
    relayUrl: RELAY,
    siteId: "site_a",
    deviceId: "dev_a",
    origin: "https://a.test",
    displayName: "Site A",
    deviceCredential: "ubd_a",
  };
  const shim = makeChromeShim({ site: legacy });
  loadBackground(shim);
  const id = C.connectionId(RELAY, "site_a");

  const pick = await reply(shim, { type: "setAgent", connectionId: id, agentId: "agent-a" });
  assert.equal(pick.ok, true, "the id is the documented deterministic one");
  const state = await reply(shim, { type: "getConnections" });
  assert.ok(state.connections[id], "the migration produced the connection");
  assert.equal(state.connections[id].agentId, "agent-a", "and the pick survived it");
  assert.ok(shim._storage["ub.migrated.connections"], "the marker was written");
});

test("a read that only has to write the marker keeps a concurrent pick", async () => {
  // Connections exist but the marker is missing, so the next read writes one.
  const a = conn();
  const shim = makeChromeShim({ connections: { [a.connectionId]: a } });
  loadBackground(shim);

  const [pick, state] = await Promise.all([
    reply(shim, { type: "setAgent", connectionId: a.connectionId, agentId: "agent-a" }),
    reply(shim, { type: "getConnections" }),
  ]);
  assert.equal(pick.ok, true);
  assert.ok(state.connections[a.connectionId], "the read saw the connection");
  assert.equal(shim._storage.connections[a.connectionId].agentId, "agent-a", "the pick was not overwritten");
  assert.ok(shim._storage["ub.migrated.connections"], "the marker was written");
});
