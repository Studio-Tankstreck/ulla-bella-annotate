"use strict";

// Job routing tests against the REAL service worker: which connection a round
// may be sent through, and which receiver a resumed round is polled against.
// Everything after a resolve must keep its original relay/credential — a job may
// never move to another Relay that happens to host the same siteId.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { makeChromeShim, loadBackground, reply, waitFor } = require("./support/worker-shim");
const C = require(path.join(__dirname, "..", "src", "connections.js"));

const RELAY_A = "http://relay-a.test:8787";
const RELAY_B = "http://relay-b.test:8787";

function conn(over) {
  return C.normalizeConnection(
    Object.assign(
      {
        relayUrl: RELAY_A,
        siteId: "site1",
        deviceId: "dev1",
        origin: "https://one.test",
        displayName: "Site One",
        deviceCredential: "cred-a",
      },
      over || {}
    )
  );
}

function seedOf(list, extra) {
  const map = {};
  for (const raw of list) map[raw.connectionId] = raw;
  return Object.assign({ connections: map, "ub.migrated.connections": { at: 1, version: 1 } }, extra || {});
}

function job(over) {
  return Object.assign(
    {
      jobId: "job1",
      siteId: "site1",
      deviceId: "dev1",
      annotations: [{ annotationId: "a1", instruction: "Change the heading", target: { url: "https://one.test/" } }],
    },
    over || {}
  );
}

function recordPost() {}

test("an explicit connection that is gone fails before any network call", async () => {
  const b = conn({ relayUrl: RELAY_B, deviceCredential: "cred-b" });
  const shim = makeChromeShim(seedOf([b])); // same siteId, other relay
  loadBackground(shim);

  const resp = await reply(shim, {
    type: "submitJob",
    job: job(),
    connectionId: C.connectionId(RELAY_A, "site1"),
  });
  assert.equal(resp.ok, false);
  assert.equal(resp.error.code, "connection_not_found");
  assert.deepEqual(shim._fetches, [], "nothing was sent anywhere");
  assert.equal(shim._storage.jobs, undefined, "and no job record was left behind");
});

test("a legacy message without connectionId is refused when the site is ambiguous", async () => {
  const a = conn();
  const b = conn({ relayUrl: RELAY_B, deviceCredential: "cred-b" });
  const shim = makeChromeShim(seedOf([a, b]));
  loadBackground(shim);

  const resp = await reply(shim, { type: "submitJob", job: job() });
  assert.equal(resp.ok, false);
  assert.equal(resp.error.code, "ambiguous_connection");
  assert.deepEqual(shim._fetches, []);
});

test("a legacy message without connectionId still works when only one connection serves the site", async () => {
  const a = conn();
  const other = conn({ siteId: "site2", deviceId: "dev2", origin: "https://two.test" });
  const shim = makeChromeShim(seedOf([a, other]));
  const posts = [];
  shim._fetch = async function (url, opts) {
    shim._fetches.push({ url: url });
    if (opts && opts.method === "POST") posts.push({ url: url, opts: opts });
    return { ok: true, status: 202, json: async () => ({ payload: { jobId: "job1", status: "working" } }) };
  };
  loadBackground(shim); // after the mock: the worker polls on start too

  const resp = await reply(shim, { type: "submitJob", job: job() });
  assert.equal(resp.ok, true);
  assert.equal(posts.length, 1, "exactly one submit");
  assert.equal(posts[0].url, RELAY_A + "/v1/jobs", "sent to the one connection that serves the site");
  assert.equal(posts[0].opts.headers.Authorization, "Bearer cred-a");
  assert.equal(shim._storage.jobs.job1.connectionId, a.connectionId, "the snapshot names that connection");
});

test("a round whose site or device does not match its connection is refused", async () => {
  const a = conn();
  const shim = makeChromeShim(seedOf([a]));
  loadBackground(shim);

  const wrongSite = await reply(shim, {
    type: "submitJob",
    job: job({ siteId: "site9" }),
    connectionId: a.connectionId,
  });
  assert.equal(wrongSite.ok, false);
  assert.equal(wrongSite.error.code, "site_mismatch");

  const wrongDevice = await reply(shim, {
    type: "submitJob",
    job: job({ deviceId: "dev9" }),
    connectionId: a.connectionId,
  });
  assert.equal(wrongDevice.ok, false);
  assert.equal(wrongDevice.error.code, "device_mismatch");
  assert.deepEqual(shim._fetches, []);
});

test("a round accepted through one connection keeps it when the settings change", async () => {
  const a = conn({ agentId: "agent-a" });
  const shim = makeChromeShim(seedOf([a]));
  loadBackground(shim);
  shim._fetch = async function (url) {
    shim._fetches.push({ url: url });
    return { ok: true, status: 202, json: async () => ({ payload: { jobId: "job1", status: "working" } }) };
  };
  globalThis.fetch = shim._fetch;

  const resp = await reply(shim, { type: "submitJob", job: job(), connectionId: a.connectionId, sessionKey: "k1" });
  assert.equal(resp.ok, true);
  assert.equal(shim._storage.jobs.job1.relayUrl, RELAY_A);
  assert.equal(shim._storage.jobs.job1.deviceCredential, "cred-a");
  assert.equal(shim._storage.jobs.job1.agentId, "agent-a");
});

test("a resumed round after a disconnect keeps its original receiver", async () => {
  const a = conn({ deviceCredential: "cred-a" });
  const b = conn({ relayUrl: RELAY_B, deviceCredential: "cred-b" }); // same siteId, other relay
  const shim = makeChromeShim(
    seedOf([a, b], {
      jobs: {
        job1: {
          jobId: "job1",
          siteId: "site1",
          connectionId: a.connectionId,
          sessionKey: "k1",
          relayUrl: RELAY_A,
          deviceCredential: "cred-a",
          agentId: "",
          status: "working",
          startedAt: Date.now(),
          tabId: 5,
        },
      },
    })
  );
  const polls = [];
  shim._fetch = async function (url, opts) {
    polls.push({ url: url, auth: opts && opts.headers && opts.headers.Authorization });
    return { ok: true, status: 200, json: async () => ({ payload: { jobId: "job1", status: "working" } }) };
  };
  loadBackground(shim); // polls the stored round on start, through its own snapshot

  // Disconnect A: only B (another relay, same siteId) remains.
  const gone = await reply(shim, { type: "disconnect", connectionId: a.connectionId });
  assert.equal(gone.ok, true);
  const before = polls.length;

  const resp = await reply(shim, { type: "resumePoll", jobId: "job1", sessionKey: "k1", connectionId: b.connectionId });
  assert.equal(resp.ok, true);
  await waitFor(() => polls.length > before, "a poll after the resume");
  assert.ok(
    polls.every((f) => f.url === RELAY_A + "/v1/jobs/job1"),
    "always polled its own relay: " + JSON.stringify(polls.map((p) => p.url))
  );
  assert.ok(
    polls.every((f) => f.auth === "Bearer cred-a"),
    "with its own credential: " + JSON.stringify(polls.map((p) => p.auth))
  );
});

test("a resumed round with no snapshot and no connection is reported, not re-routed", async () => {
  const b = conn({ relayUrl: RELAY_B, deviceCredential: "cred-b" });
  const shim = makeChromeShim(
    seedOf([b], {
      jobs: {
        job1: {
          jobId: "job1",
          siteId: "site1",
          connectionId: C.connectionId(RELAY_A, "site1"),
          sessionKey: "k1",
          status: "working",
          startedAt: Date.now(),
          tabId: 5,
        },
      },
    })
  );
  loadBackground(shim);

  const resp = await reply(shim, { type: "resumePoll", jobId: "job1", sessionKey: "k1" });
  assert.equal(resp.ok, false);
  assert.equal(resp.error.code, "connection_not_found");
  assert.deepEqual(shim._fetches, [], "nothing was polled on another connection");
  assert.equal(shim._storage.jobs.job1.status, "error", "the record is marked, not moved");
  assert.ok(shim._storage.jobs.job1.orphanedAt, "and flagged so a restart stops polling it");
  const told = shim._messages.filter((m) => m.msg && m.msg.type === "ubJobStatus");
  assert.equal(told.length, 1, "the tab was told");
  assert.equal(told[0].msg.status, "error");
  assert.equal(told[0].msg.error.code, "connection_not_found");
});

test("a resume with no record is pinned to the explicit connection only", async () => {
  const a = conn();
  const b = conn({ relayUrl: RELAY_B, deviceCredential: "cred-b" });
  const shim = makeChromeShim(seedOf([a, b]));
  loadBackground(shim);

  const noId = await reply(shim, { type: "resumePoll", jobId: "job1", sessionKey: "k1" });
  assert.equal(noId.ok, false);
  assert.equal(noId.error.code, "connection_not_found", "a missing id is not guessed by siteId");

  const badId = await reply(shim, { type: "resumePoll", jobId: "job1", sessionKey: "k1", connectionId: C.connectionId(RELAY_A, "nope") });
  assert.equal(badId.ok, false);
  assert.equal(badId.error.code, "connection_not_found");

  const good = await reply(shim, { type: "resumePoll", jobId: "job1", sessionKey: "k1", connectionId: b.connectionId });
  assert.equal(good.ok, true);
  assert.equal(shim._storage.jobs.job1.connectionId, b.connectionId);
  assert.equal(shim._storage.jobs.job1.relayUrl, RELAY_B);
});
