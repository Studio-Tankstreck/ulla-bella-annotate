"use strict";

// Shared chrome shim for loading the REAL service worker (src/background.js) in
// node. It mirrors the surface background.js touches and keeps the storage in a
// plain object, so a test can seed, inspect and "reload" the worker.

const path = require("node:path");

const SRC = path.join(__dirname, "..", "..", "src");

function loadModules() {
  if (!globalThis.UllaBellaMessages) globalThis.UllaBellaMessages = require(path.join(SRC, "i18n-messages.js"));
  if (!globalThis.UllaBellaI18n) globalThis.UllaBellaI18n = require(path.join(SRC, "i18n.js"));
  if (!globalThis.UllaBella) globalThis.UllaBella = require(path.join(SRC, "lib.js"));
  if (!globalThis.UllaBellaPair) globalThis.UllaBellaPair = require(path.join(SRC, "pair.js"));
  if (!globalThis.UllaBellaRelayPolicy) globalThis.UllaBellaRelayPolicy = require(path.join(SRC, "relay-policy.js"));
  if (!globalThis.UllaBellaIcons) globalThis.UllaBellaIcons = require(path.join(SRC, "icons.js"));
  if (!globalThis.UllaBellaMonitor) globalThis.UllaBellaMonitor = require(path.join(SRC, "monitor.js"));
  if (!globalThis.UllaBellaSession) globalThis.UllaBellaSession = require(path.join(SRC, "session.js"));
  if (!globalThis.UllaBellaSessionWriter) globalThis.UllaBellaSessionWriter = require(path.join(SRC, "session-writer.js"));
  if (!globalThis.UllaBellaConnections) globalThis.UllaBellaConnections = require(path.join(SRC, "connections.js"));
  if (!globalThis.importScripts) globalThis.importScripts = function () {};
}

function makeChromeShim(seed) {
  const storage = Object.assign({}, seed || {});
  const listeners = [];

  function notify(changes) {
    for (const fn of listeners) {
      try {
        fn(changes);
      } catch (_) {}
    }
  }

  const shim = {
    _storage: storage,
    _fetches: [],
    _messages: [],
    _onMessage: null,
    _registered: [],
    _alarms: [],

    storage: {
      local: {
        async get(key) {
          if (key == null) return Object.assign({}, storage);
          if (typeof key === "string") return key in storage ? { [key]: storage[key] } : {};
          if (Array.isArray(key)) {
            const out = {};
            for (const k of key) if (k in storage) out[k] = storage[k];
            return out;
          }
          const out = {};
          for (const k of Object.keys(key)) out[k] = k in storage ? storage[k] : key[k];
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const k of Object.keys(obj)) {
            changes[k] = { oldValue: storage[k], newValue: obj[k] };
            storage[k] = obj[k];
          }
          notify(changes);
          return undefined;
        },
        async remove(key) {
          for (const k of Array.isArray(key) ? key : [key]) delete storage[k];
        },
        async clear() {
          for (const k of Object.keys(storage)) delete storage[k];
        },
      },
      onChanged: {
        addListener(fn) {
          listeners.push(fn);
        },
      },
    },

    alarms: {
      async get(name) {
        return shim._alarms.find((a) => a.name === name);
      },
      create(name, opts) {
        shim._alarms.push(Object.assign({ name }, opts));
      },
      async clear(name) {
        shim._alarms = shim._alarms.filter((a) => a.name !== name);
        return true;
      },
      onAlarm: { addListener() {} },
    },

    action: {
      setBadgeText() {
        return Promise.resolve();
      },
      setBadgeBackgroundColor() {
        return Promise.resolve();
      },
      setTitle() {
        return Promise.resolve();
      },
      setIcon() {
        return Promise.resolve();
      },
    },

    tabs: {
      sendMessage(tabId, msg) {
        shim._messages.push({ tabId: tabId, msg: msg });
        return Promise.resolve();
      },
      query() {
        return Promise.resolve([]);
      },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },

    runtime: {
      onMessage: {
        addListener(fn) {
          shim._onMessage = fn;
        },
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onSuspend: { addListener() {} },
      getURL(p) {
        return "chrome-extension://test/" + p;
      },
      lastError: null,
    },

    permissions: {
      _granted: [],
      async contains(q) {
        return (q.origins || []).every((o) => shim.permissions._granted.indexOf(o) !== -1);
      },
      async request(q) {
        (q.origins || []).forEach((o) => shim.permissions._granted.push(o));
        return true;
      },
      async remove(q) {
        shim.permissions._granted = shim.permissions._granted.filter(
          (o) => (q.origins || []).indexOf(o) === -1
        );
        return true;
      },
    },

    scripting: {
      async getRegisteredContentScripts() {
        return shim._registered.slice();
      },
      async registerContentScripts(list) {
        shim._registered = shim._registered.concat(list);
      },
      async updateContentScripts(list) {
        shim._registered = shim._registered.map((s) => {
          const next = list.find((n) => n.id === s.id);
          return next || s;
        });
      },
      async unregisterContentScripts() {
        shim._registered = [];
      },
      async executeScript() {},
      async insertCSS() {},
    },
  };

  // Every fetch goes through the test: nothing here ever touches the network.
  shim._fetch = async function (url, opts) {
    shim._fetches.push({ url: url, opts: opts });
    return {
      ok: false,
      status: 599,
      json: async () => ({ payload: { error: { code: "test_no_network" } } }),
    };
  };

  return shim;
}

function loadBackground(shim) {
  loadModules();
  globalThis.chrome = shim;
  globalThis.fetch = shim._fetch;
  const bgPath = path.join(SRC, "background.js");
  delete require.cache[require.resolve(bgPath)];
  require(bgPath);
  return shim;
}

// reply sends a message to the worker and resolves with its response.
function reply(shim, msg, sender) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no response for " + msg.type)), 3000);
    shim._onMessage(msg, sender || {}, (resp) => {
      clearTimeout(timer);
      resolve(resp);
    });
  });
}

async function waitFor(cond, what, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 2000);
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + (what || "condition"));
    await new Promise((r) => setTimeout(r, 5));
  }
}

module.exports = { makeChromeShim, loadBackground, reply, waitFor, SRC };
