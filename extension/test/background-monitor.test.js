"use strict";

// Integration test for the service worker's job monitoring, loaded against a
// minimal chrome shim. Verifies: submit -> terminal done; a transient network
// error pauses (not fails) the job; and resume re-attaches without re-submitting.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

// Expose the UMD modules as globals, the way importScripts() would.
globalThis.UllaBellaMessages = require(path.join(SRC, "i18n-messages.js"));
globalThis.UllaBellaI18n = require(path.join(SRC, "i18n.js"));
globalThis.UllaBella = require(path.join(SRC, "lib.js"));
globalThis.UllaBellaPair = require(path.join(SRC, "pair.js"));
globalThis.UllaBellaRelayPolicy = require(path.join(SRC, "relay-policy.js"));
globalThis.UllaBellaIcons = require(path.join(SRC, "icons.js"));
globalThis.UllaBellaMonitor = require(path.join(SRC, "monitor.js"));
globalThis.UllaBellaSession = require(path.join(SRC, "session.js"));
globalThis.UllaBellaSessionWriter = require(path.join(SRC, "session-writer.js"));
globalThis.UllaBellaConnections = require(path.join(SRC, "connections.js"));
globalThis.importScripts = function () {};

const monitor = globalThis.UllaBellaMonitor;

function makeChromeShim() {
  const storage = {};
  const shim = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return { [key]: storage[key] };
          return Object.assign({}, storage);
        },
        async set(obj) { Object.assign(storage, obj); },
      },
    },
    alarms: {
      list: [],
      async get(name) { return this.list.find((a) => a.name === name); },
      create(name, opts) { this.list.push(Object.assign({ name }, opts)); },
      async clear(name) { this.list = this.list.filter((a) => a.name !== name); },
      onAlarm: { addListener(fn) { shim._alarmListener = fn; } },
    },
    action: {
      _badge: { text: "", color: "", title: "" },
      setBadgeText(o) { this._badge.text = o.text; return Promise.resolve(); },
      setBadgeBackgroundColor(o) { this._badge.color = o.color; return Promise.resolve(); },
      setTitle(o) { this._badge.title = o.title; return Promise.resolve(); },
      setIcon() { return Promise.resolve(); },
    },
    tabs: {
      _messages: [],
      sendMessage(tabId, msg) { this._messages.push(msg); return Promise.resolve(); },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
      query() { return Promise.resolve([]); },
    },
    runtime: {
      onMessage: { addListener(fn) { shim._onMessage = fn; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      getURL(p) { return "chrome-extension://test/" + p; },
    },
    permissions: { contains() { return Promise.resolve(false); } },
    scripting: {},
    _storage: storage,
  };
  return shim;
}

function loadBackground(shim) {
  globalThis.chrome = shim;
  const bgPath = path.join(SRC, "background.js");
  delete require.cache[require.resolve(bgPath)];
  require(bgPath);
  return shim;
}

async function waitFor(cond, timeoutMs, what) {
  const deadline = Date.now() + (timeoutMs || 2000);
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + (what || "condition"));
    await new Promise((r) => setTimeout(r, 5));
  }
}

function seedSite(shim) {
  return shim.storage.local.set({
    site: {
      deviceId: "dev1",
      siteId: "site1",
      relayUrl: "http://relay",
      origin: "https://example.test",
      displayName: "Test",
      deviceCredential: "ubd_cred",
    },
  });
}

function minimalJob() {
  return { jobId: "job1", siteId: "site1", deviceId: "dev1", annotations: [] };
}

// --- tests -------------------------------------------------------------------

test("submitJob polls to a terminal done and clears the job + badge", async () => {
  monitor.POLL_INTERVAL_MS = 2;
  monitor.HEARTBEAT_INTERVAL_MS = 2;
  const shim = makeChromeShim();
  loadBackground(shim);
  await seedSite(shim);

  let posts = 0;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === "POST") {
      posts++;
      return { ok: true, json: async () => ({ payload: { jobId: "job1", status: "accepted" } }) };
    }
    return { json: async () => ({ payload: { status: "done", summary: "ok", verification: { status: "passed", summary: "ok" } } }) };
  };

  let resp;
  shim._onMessage({ type: "submitJob", job: minimalJob() }, { tab: { id: 7 } }, (r) => { resp = r; });

  await waitFor(() => resp && resp.ok === true, 2000, "submit response");
  await waitFor(() => shim.action._badge.text === "✓", 2000, "done badge");
  assert.equal(posts, 1, "job must be POSTed exactly once");

  const jobs = (await shim.storage.local.get("jobs"))["jobs"] || {};
  assert.equal(Object.keys(jobs).length, 0, "job record removed on terminal");

  // A terminal ubJobStatus message reached the tab.
  const done = shim.tabs._messages.find((m) => m.status === "done");
  assert.ok(done, "terminal done message delivered");
  assert.equal(done.jobId, "job1");
});

test("a transient network error pauses the job instead of failing it", async () => {
  monitor.POLL_INTERVAL_MS = 2;
  monitor.HEARTBEAT_INTERVAL_MS = 2;
  const shim = makeChromeShim();
  loadBackground(shim);
  await seedSite(shim);

  let fail = true;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === "POST") {
      return { ok: true, json: async () => ({ payload: { jobId: "job1", status: "accepted" } }) };
    }
    if (fail) throw new Error("network down");
    return { json: async () => ({ payload: { status: "done", summary: "ok", verification: { status: "passed" } } }) };
  };

  shim._onMessage({ type: "submitJob", job: minimalJob() }, { tab: { id: 7 } }, () => {});

  await waitFor(() => shim.tabs._messages.some((m) => m.status === "paused"), 2000, "paused message");
  assert.equal(shim.action._badge.text, "…", "paused keeps a working badge, not a failure badge");

  const jobs = (await shim.storage.local.get("jobs"))["jobs"] || {};
  assert.equal(jobs["job1"].status, "paused", "job persisted as paused (not failed)");
});

test("resumeActiveJobs re-attaches to a paused job without re-POSTing", async () => {
  monitor.POLL_INTERVAL_MS = 2;
  monitor.HEARTBEAT_INTERVAL_MS = 2;
  const shim = makeChromeShim();
  loadBackground(shim);
  await seedSite(shim);

  let posts = 0;
  let down = true;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === "POST") {
      posts++;
      return { ok: true, json: async () => ({ payload: { jobId: "job1", status: "accepted" } }) };
    }
    if (down) throw new Error("network down");
    return { json: async () => ({ payload: { status: "done", summary: "ok", verification: { status: "passed" } } }) };
  };

  shim._onMessage({ type: "submitJob", job: minimalJob() }, { tab: { id: 7 } }, () => {});
  await waitFor(() => shim.tabs._messages.some((m) => m.status === "paused"), 2000, "paused");

  // Network recovers; the alarm tick (or worker restart) resumes.
  down = false;
  await shim._alarmListener({ name: "ullabella-monitor" });

  await waitFor(() => shim.tabs._messages.some((m) => m.status === "done"), 2000, "resumed done");
  assert.equal(posts, 1, "resume must not re-POST the job");
  const jobs = (await shim.storage.local.get("jobs"))["jobs"] || {};
  assert.equal(Object.keys(jobs).length, 0, "job cleared after resumed terminal");
});

test("pollLoop forwards a changed agent-activity snapshot to the tab", async () => {
  monitor.POLL_INTERVAL_MS = 2;
  monitor.HEARTBEAT_INTERVAL_MS = 60 * 1000; // suppress heartbeat during the test
  const shim = makeChromeShim();
  loadBackground(shim);
  await seedSite(shim);

  let polls = 0;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === "POST") {
      return { ok: true, json: async () => ({ payload: { jobId: "job1", status: "accepted" } }) };
    }
    polls++;
    if (polls === 1) {
      return { json: async () => ({ payload: { status: "working", activity: { kind: "using_tools", activityAt: "2026-10-16T00:00:00Z", checkedAt: "2026-10-16T00:00:01Z" } } }) };
    }
    return { json: async () => ({ payload: { status: "done", summary: "ok", verification: { status: "passed" } } }) };
  };

  shim._onMessage({ type: "submitJob", job: minimalJob() }, { tab: { id: 7 } }, () => {});

  await waitFor(() => shim.tabs._messages.some((m) => m.activity && m.activity.kind === "using_tools"), 2000, "activity forwarded");
  await waitFor(() => shim.tabs._messages.some((m) => m.status === "done"), 2000, "done");
});

// --- the single session writer, through the worker's own message handler -----

test("writeSession merges, persists, and cannot be undone by a stale document", async () => {
  const shim = makeChromeShim();
  loadBackground(shim);
  await seedSite(shim);

  const sessionMod = globalThis.UllaBellaSession;
  const pageId = "https://example.test/services";
  const key = sessionMod.storageKey("site1", pageId);
  const base = sessionMod.withAnnotations(
    sessionMod.empty({ siteId: "site1", pageId: pageId }),
    [{ annotationId: "ann_old", instruction: "old", target: {} }]
  );
  await shim.storage.local.set({ [key]: base });

  // A deletion from a content script.
  let first;
  shim._onMessage(
    { type: "writeSession", sessionKey: key, session: sessionMod.removeAnnotation(base, "ann_old") },
    {},
    (r) => {
      first = r;
    }
  );
  await waitFor(() => first && first.ok === true, 2000, "write response");
  assert.equal(first.written, true);
  assert.ok(first.session.deleted.ann_old, "the answer is the stored document");

  // A stale content script (loaded before the deletion) writes afterwards.
  let second;
  shim._onMessage({ type: "writeSession", sessionKey: key, session: base }, {}, (r) => {
    second = r;
  });
  await waitFor(() => second && second.ok === true, 2000, "second write response");

  const stored = (await shim.storage.local.get(key))[key];
  assert.ok(stored.deleted.ann_old, "the tombstone survives the stale write");
  assert.deepEqual(stored.annotations, [], "the stale document cannot restore ann_old");
  assert.equal(stored.sessionId, base.sessionId, "same session lineage");
});
