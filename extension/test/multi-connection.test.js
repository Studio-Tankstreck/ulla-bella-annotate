"use strict";

// Etapp 3 integration tests: several connections in one extension, per-origin
// resolution, the legacy single-pairing migration, agent pinning and
// disconnect — all through the REAL content script and the real writer.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { makeStorage, makeWorker, settle, openTab } = require("./support/tab");
const S = require(path.join(__dirname, "..", "src", "session.js"));
const C = require(path.join(__dirname, "..", "src", "connections.js"));
const pageId = require(path.join(__dirname, "..", "src", "queue.js")).pageId;

const RELAY_A = "http://relay-a.test:8787";
const RELAY_B = "http://relay-b.test:8787";
const ORIGIN_A = "https://alpha.test";
const ORIGIN_B = "https://beta.test";
const URL_A = ORIGIN_A + "/tjanster";
const URL_B = ORIGIN_B + "/tjanster";

function site(over) {
  return Object.assign(
    {
      relayUrl: RELAY_A,
      siteId: "site_alpha",
      deviceId: "dev_a",
      origin: ORIGIN_A,
      displayName: "Alpha",
      deviceCredential: "ubd_a",
    },
    over || {}
  );
}

function ann(id, instruction, url) {
  return {
    annotationId: id,
    instruction: instruction,
    target: { url: url || URL_A, elementType: "h1", visibleText: instruction, selector: "h1" },
  };
}

// seedConnections writes the connection map directly (as the background does).
function seedConnections(storage, list, active) {
  const map = {};
  for (const raw of list) {
    const c = C.normalizeConnection(raw);
    assert.ok(c, "test connection is well formed");
    map[c.connectionId] = c;
  }
  storage.seed(
    Object.assign({}, storage.raw(), {
      connections: map,
      activeByOrigin: active || {},
      "ub.migrated.connections": { at: 1, version: 1 },
    })
  );
  return map;
}

function setup(list, active) {
  const storage = makeStorage();
  const map = seedConnections(storage, list, active);
  const worker = makeWorker(storage);
  return {
    storage: storage,
    worker: worker,
    map: map,
    tab: function (url, opts) {
      return openTab(Object.assign({ storage: storage, worker: worker, url: url }, opts || {}));
    },
  };
}

test("two connected sites never share a queue, a description or a job", async () => {
  const s = setup([
    site(),
    site({ siteId: "site_beta", origin: ORIGIN_B, displayName: "Beta", deviceId: "dev_b" }),
  ]);

  const alpha = s.tab(URL_A);
  await alpha.toggle();
  await alpha.addAnnotation("h1", "Alpha heading", "Change the alpha heading");
  await alpha.editDescription("Alpha session description");

  const beta = s.tab(URL_B);
  await beta.toggle();
  await beta.openPanel();
  assert.deepEqual(beta.queueTexts(), [], "the other site starts empty");
  assert.equal(beta.descriptionText(), "No session description yet.");
  await beta.addAnnotation("h1", "Beta heading", "Change the beta heading");

  // Each session is stored under its own connection key.
  const alphaKey = S.storageKey(C.connectionId(RELAY_A, "site_alpha"), pageId(URL_A));
  const betaKey = S.storageKey(C.connectionId(RELAY_A, "site_beta"), pageId(URL_B));
  assert.deepEqual(
    s.storage.raw()[alphaKey].annotations.map((a) => a.instruction),
    ["Change the alpha heading"]
  );
  assert.equal(s.storage.raw()[alphaKey].description, "Alpha session description");
  assert.deepEqual(
    s.storage.raw()[betaKey].annotations.map((a) => a.instruction),
    ["Change the beta heading"]
  );
  assert.equal(s.storage.raw()[betaKey].description, "");
});

test("the same siteId on two relays is two connections and two sessions", async () => {
  const a = C.normalizeConnection(site());
  const b = C.normalizeConnection(site({ relayUrl: RELAY_B, displayName: "Alpha (relay B)" }));
  assert.notEqual(a.connectionId, b.connectionId);

  const s = setup([site(), site({ relayUrl: RELAY_B, displayName: "Alpha (relay B)" })], {
    [ORIGIN_A]: a.connectionId,
  });

  const tab = s.tab(URL_A);
  await tab.toggle();
  assert.equal(tab.markers().length + (await tab.queueTexts()).length, 0);
  await tab.addAnnotation("h1", "Alpha heading", "Written to relay A");
  await tab.editDescription("Relay A session");

  const keyA = S.storageKey(a.connectionId, pageId(URL_A));
  const keyB = S.storageKey(b.connectionId, pageId(URL_A));
  assert.deepEqual(
    s.storage.raw()[keyA].annotations.map((x) => x.instruction),
    ["Written to relay A"]
  );
  assert.equal(s.storage.raw()[keyB], undefined, "the other relay's session is untouched");
});

test("with several connections for one origin nothing happens until the user chooses", async () => {
  const s = setup([site(), site({ relayUrl: RELAY_B, displayName: "Alpha (relay B)" })]);

  const tab = s.tab(URL_A);
  await tab.toggle(); // no explicit choice yet
  assert.equal(tab.markers().length, 0, "no editing without an explicit choice");
  assert.equal(tab.panel(), null);

  // The user chooses the relay-B connection for this origin.
  const chosen = C.connectionId(RELAY_B, "site_alpha");
  await s.storage.local.set({ activeByOrigin: { [ORIGIN_A]: chosen } });
  await settle(s.storage);

  await tab.toggle();
  assert.equal(tab.markers().length, 0);
  await tab.addAnnotation("h1", "Alpha heading", "Written after the choice");
  const key = S.storageKey(chosen, pageId(URL_A));
  assert.deepEqual(
    s.storage.raw()[key].annotations.map((a) => a.instruction),
    ["Written after the choice"]
  );
});

test("changing the choice re-points an open tab at the other connection", async () => {
  const s = setup([site(), site({ relayUrl: RELAY_B, displayName: "Alpha (relay B)" })], {
    [ORIGIN_A]: C.connectionId(RELAY_A, "site_alpha"),
  });

  const tab = s.tab(URL_A);
  await tab.toggle();
  await tab.addAnnotation("h1", "Alpha heading", "On relay A");
  assert.deepEqual(tab.queueTexts(), ["On relay A"]);

  // Switch the origin to the relay-B connection.
  await s.storage.local.set({ activeByOrigin: { [ORIGIN_A]: C.connectionId(RELAY_B, "site_alpha") } });
  await settle(s.storage);

  assert.deepEqual(tab.queueTexts(), [], "the tab now shows the other connection's session");
  await tab.addAnnotation("h2", "Beta heading", "On relay B");
  const keyB = S.storageKey(C.connectionId(RELAY_B, "site_alpha"), pageId(URL_A));
  assert.deepEqual(
    s.storage.raw()[keyB].annotations.map((a) => a.instruction),
    ["On relay B"]
  );
  const keyA = S.storageKey(C.connectionId(RELAY_A, "site_alpha"), pageId(URL_A));
  assert.deepEqual(
    s.storage.raw()[keyA].annotations.map((a) => a.instruction),
    ["On relay A"],
    "the first connection's work is kept"
  );
});

test("adding a second connection keeps the first one and its session", async () => {
  const s = setup([site()]);
  const tab = s.tab(URL_A);
  await tab.toggle();
  await tab.addAnnotation("h1", "Alpha heading", "Keep me");

  // "Import" a second site: the background upserts; nothing is replaced.
  const beta = C.normalizeConnection(site({ siteId: "site_beta", origin: ORIGIN_B, displayName: "Beta" }));
  const state = s.storage.raw();
  const map = C.upsert(state.connections, beta);
  await s.storage.local.set({ connections: map });
  await settle(s.storage);

  assert.equal(Object.keys(map).length, 2);
  const keyA = S.storageKey(C.connectionId(RELAY_A, "site_alpha"), pageId(URL_A));
  assert.deepEqual(
    s.storage.raw()[keyA].annotations.map((a) => a.instruction),
    ["Keep me"],
    "the first connection's session is intact"
  );
  assert.deepEqual(tab.queueTexts(), ["Keep me"], "and still visible in the open tab");
});

test("the legacy single pairing is migrated without losing its session", async () => {
  const storage = makeStorage();
  const legacyKey = S.storageKey("site_alpha", pageId(URL_A)); // pre-etapp-3: siteId only
  const doc = S.withAnnotations(
    S.empty({ siteId: "site_alpha", pageId: pageId(URL_A), siteName: "Alpha", pageUrl: URL_A }),
    [ann("ann_legacy", "Legacy annotation")]
  );
  storage.seed({ site: site(), [legacyKey]: Object.assign({}, doc, { description: "Legacy purpose", intro: "completed" }) });
  const worker = makeWorker(storage);
  const tab = openTab({ storage: storage, worker: worker, url: URL_A });
  await tab.toggle();
  await tab.openPanel();

  assert.deepEqual(tab.queueTexts(), ["Legacy annotation"], "the old queue is adopted");
  assert.equal(tab.descriptionText(), "Legacy purpose", "the old description comes along");
  assert.equal(tab.hasIntro(), false, "the completed first step is not asked again");

  const newKey = S.storageKey(C.connectionId(RELAY_A, "site_alpha"), pageId(URL_A));
  assert.ok(storage.raw()[newKey], "the session now lives under the connection key");
  assert.equal(storage.raw()[newKey].sessionId, doc.sessionId, "same session identity (no new session)");

  // A second relay with the same siteId must NOT inherit the migrated session.
  const otherRelay = openTab({
    storage: storage,
    worker: worker,
    url: URL_A,
    page: [],
  });
  void otherRelay; // (the origin now resolves to the migrated connection; covered below)
  const second = C.upsert(storage.raw().connections, site({ relayUrl: RELAY_B, displayName: "Alpha (relay B)" }));
  await storage.local.set({ connections: second });
  await settle(storage);
  const otherKey = S.storageKey(C.connectionId(RELAY_B, "site_alpha"), pageId(URL_A));
  assert.equal(storage.raw()[otherKey], undefined, "the second relay starts without a session");
});

test("a submitted round keeps its agent and connection even after settings change", async () => {
  const s = setup([site({ agentId: "agent_a", agentName: "Agent A" })]);
  const tab = s.tab(URL_A);
  await tab.toggle();
  await tab.addAnnotation("h1", "Alpha heading", "Change the heading");
  await tab.send();

  const cid = C.connectionId(RELAY_A, "site_alpha");
  const key = S.storageKey(cid, pageId(URL_A));
  const job = tab.lastJob();
  assert.ok(job, "a job was submitted");
  assert.equal(job.agentId, "agent_a", "the chosen agent travels with the job");
  assert.equal(s.storage.raw()[key].job.agentId, "agent_a", "the round snapshots its agent");
  assert.equal(s.storage.raw()[key].job.connectionId, cid, "and the connection it was sent through");

  // The user switches the agent for the NEXT round.
  await s.storage.local.set({
    connections: C.withAgent(s.storage.raw().connections, cid, "agent_b", "Agent B"),
  });
  await settle(s.storage);

  assert.equal(job.agentId, "agent_a", "the already-sent payload is unchanged");
  assert.equal(
    s.storage.raw()[key].job.agentId,
    "agent_a",
    "the accepted round keeps the agent it was sent to"
  );
  assert.equal(s.storage.raw()[key].job.connectionId, cid, "and its connection");

  // Finish the first round, then send a new one: it carries the new agent.
  tab.answerSend({ ok: true });
  tab.msg({
    type: "ubJobStatus",
    status: "done",
    jobId: job.jobId,
    annotationResults: job.annotations.map((a) => ({ annotationId: a.annotationId, status: "done", summary: "ok" })),
  });
  await settle(s.storage);
  await tab.addAnnotation("h2", "Second heading", "Another change");
  await tab.send();
  assert.equal(tab.lastJob().agentId, "agent_b");
});

test("no agent chosen means no agentId on the wire (older behaviour)", async () => {
  const s = setup([site()]);
  const tab = s.tab(URL_A);
  await tab.toggle();
  await tab.addAnnotation("h1", "Alpha heading", "Change the heading");
  await tab.send();
  assert.equal(tab.lastJob().agentId, undefined, "the job leaves the agent to the Relay");
});

test("disconnecting one site leaves the other one working", async () => {
  const alpha = C.normalizeConnection(site());
  const beta = C.normalizeConnection(site({ siteId: "site_beta", origin: ORIGIN_B, displayName: "Beta" }));
  const s = setup([site(), site({ siteId: "site_beta", origin: ORIGIN_B, displayName: "Beta" })]);

  const tabB = s.tab(URL_B);
  await tabB.toggle();
  await tabB.addAnnotation("h1", "Beta heading", "Beta work");

  // Disconnect Alpha exactly as the background does.
  const after = C.without(s.storage.raw().connections, s.storage.raw().activeByOrigin, alpha.connectionId);
  const removed = Object.assign({}, s.storage.raw().removedConnections || {});
  removed[alpha.connectionId] = 1;
  await s.storage.local.set({
    connections: after.connections,
    activeByOrigin: after.activeByOrigin,
    removedConnections: removed,
  });
  await settle(s.storage);

  assert.deepEqual(Object.keys(after.connections), [beta.connectionId]);
  assert.deepEqual(tabB.queueTexts(), ["Beta work"], "the other site is untouched");
  const betaKey = S.storageKey(beta.connectionId, pageId(URL_B));
  assert.deepEqual(
    s.storage.raw()[betaKey].annotations.map((a) => a.instruction),
    ["Beta work"]
  );

  // The disconnected page can no longer be edited.
  const alphaTab = s.tab(URL_A);
  await alphaTab.toggle();
  assert.equal(alphaTab.markers().length, 0);
  assert.equal(alphaTab.panel(), null);
});

test("the panel names the site and the agent the changes go to", async () => {
  const s = setup([site({ agentId: "agent_a", agentName: "Agent A" })]);
  const tab = s.tab(URL_A);
  await tab.toggle();
  await tab.openPanel();
  assert.match(tab.sessionLabel(), /Alpha/);
  const agent = tab.panelPart(".ullabella-agent-label");
  assert.equal(agent.textContent, "Agent: Agent A");
});
