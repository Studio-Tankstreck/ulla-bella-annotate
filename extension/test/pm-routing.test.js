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

test('PM: explicit missing connection must never fall back',async()=>{
 const shim=makeChromeShim(); loadBackground(shim);
 const C=globalThis.UllaBellaConnections;
 const b=C.normalizeConnection({siteId:'site1',deviceId:'dev1',relayUrl:'http://relay-b',origin:'https://example.test',deviceCredential:'cred-b'});
 await shim.storage.local.set({connections:{[b.connectionId]:b},'ub.migrated.connections':{version:1}});
 let posted=[]; globalThis.fetch=async(url)=>{posted.push(url);return {ok:false,json:async()=>({payload:{error:{code:'test_stop'}}})};};
 let resp; shim._onMessage({type:'submitJob',job:minimalJob(),connectionId:'http://relay-a|site1'},{tab:{id:7}},r=>resp=r);
 await waitFor(()=>resp,2000); console.log('PM routed requests',posted);
 assert.equal(posted.length,0,'Missing explicitly selected connection must fail before network');
});
test('PM: concurrent agent choices for different sites both survive',async()=>{
 const shim=makeChromeShim(); loadBackground(shim); const C=globalThis.UllaBellaConnections;
 const a=C.normalizeConnection({siteId:'site1',relayUrl:'http://relay',origin:'https://a.test'});
 const b=C.normalizeConnection({siteId:'site2',relayUrl:'http://relay',origin:'https://b.test'});
 await shim.storage.local.set({connections:{[a.connectionId]:a,[b.connectionId]:b},'ub.migrated.connections':{version:1}});
 const call=(id,agent)=>new Promise(resolve=>shim._onMessage({type:'setAgent',connectionId:id,agentId:agent}, {}, resolve));
 await Promise.all([call(a.connectionId,'agent-a'),call(b.connectionId,'agent-b')]);
 console.log('PM selected agents',Object.values(shim._storage.connections).map(c=>[c.siteId,c.agentId]));
 assert.equal(shim._storage.connections[a.connectionId].agentId,'agent-a');
 assert.equal(shim._storage.connections[b.connectionId].agentId,'agent-b');
});
