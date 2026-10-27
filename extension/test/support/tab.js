"use strict";

// Test harness for the real extension files: a fake chrome.storage.local with
// realistic ASYNCHRONOUS get/set (a read-modify-write race is a first-class
// failure mode, so writes must land on a later turn like Chrome's IPC), plus a
// per-"tab" chrome shim so two content-script instances can run against one
// shared store — which is how the reported bug reproduces.
//
// Every interaction goes through tab.*, which re-points the globals
// (document/chrome/location/window) at that tab before dispatching. content.js
// resolves those globals at CALL time, so this is enough for per-tab isolation.

const path = require("node:path");
const { makeDocument, makePageEl } = require("./fake-dom");

const SRC = path.join(__dirname, "..", "..", "src");
const CONTENT_PATH = path.join(SRC, "content.js");

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function makeStorage(initial) {
  let data = clone(initial || {});
  const writes = [];
  const listeners = [];
  const state = { pending: 0 };
  // Held writes let a test force the interleaving "both tabs read before either
  // write lands" deterministically, for either write order.
  let holding = false;
  const held = [];

  function later(fn) {
    state.pending += 1;
    setTimeout(function () {
      try {
        fn();
      } finally {
        state.pending -= 1;
      }
    }, 0);
  }

  function notify(changes) {
    if (listeners.length === 0) return;
    later(function () {
      for (const fn of listeners.slice()) {
        try {
          fn(clone(changes), "local");
        } catch (_) {
          /* a listener throwing must not break the store */
        }
      }
    });
  }

  function applySet(snapshot) {
    const changes = {};
    for (const k of Object.keys(snapshot)) {
      changes[k] = { oldValue: clone(data[k]), newValue: clone(snapshot[k]) };
      data[k] = clone(snapshot[k]);
    }
    writes.push(clone(snapshot));
    notify(changes);
  }

  const local = {
    get(key) {
      return new Promise(function (resolve) {
        later(function () {
          const keys =
            key == null ? Object.keys(data) : Array.isArray(key) ? key : [key];
          const out = {};
          for (const k of keys) {
            if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = clone(data[k]);
          }
          resolve(out);
        });
      });
    },
    set(obj) {
      return new Promise(function (resolve) {
        const snapshot = clone(obj);
        const commit = function () {
          applySet(snapshot);
          resolve();
        };
        if (holding) {
          held.push(commit);
          return;
        }
        later(commit);
      });
    },
    remove(key) {
      return new Promise(function (resolve) {
        later(function () {
          const keys = Array.isArray(key) ? key : [key];
          const changes = {};
          for (const k of keys) {
            if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
            changes[k] = { oldValue: clone(data[k]), newValue: undefined };
            delete data[k];
          }
          resolve();
          notify(changes);
        });
      });
    },
    clear() {
      return new Promise(function (resolve) {
        later(function () {
          data = {};
          resolve();
        });
      });
    },
  };

  return {
    local: local,
    onChanged: {
      addListener: function (fn) {
        listeners.push(fn);
      },
    },
    raw: function () {
      return clone(data);
    },
    seed: function (v) {
      data = clone(v || {});
    },
    writes: writes,
    // hold() makes every subsequent set() wait until released, so a test can
    // order concurrent writes (and prove that both tabs read first).
    hold: function () {
      holding = true;
    },
    heldCount: function () {
      return held.length;
    },
    release: function () {
      holding = false;
      const pending = held.splice(0, held.length);
      for (const commit of pending) later(commit);
      return pending.length;
    },
    // releaseOne commits the oldest held write only (fine-grained ordering).
    releaseOne: function () {
      const commit = held.shift();
      if (!commit) return false;
      later(commit);
      return true;
    },
    get holding() {
      return holding;
    },
    get pending() {
      return state.pending;
    },
  };
}

// makeWorker emulates the service worker's session writer using the REAL
// session-writer module, so a test can drive several tabs through one writer —
// and can restart it (MV3 kills the worker) or make a message fail.
function makeWorker(storage) {
  const sessionMod = require(path.join(SRC, "session.js"));
  let sessionWriter = null;
  try {
    // Absent in the pre-fix tree: a test run against an older commit then gets
    // no worker, exactly like a browser without the new build.
    sessionWriter = require(path.join(SRC, "session-writer.js"));
  } catch (_) {
    sessionWriter = null;
  }
  if (!sessionWriter) throw new Error("session-writer.js is not available in this tree");

  function build() {
    return sessionWriter.createWriter({
      session: sessionMod,
      read: async function (key) {
        const data = await storage.local.get(key);
        return data && data[key];
      },
      write: async function (key, session, extra) {
        const payload = {};
        payload[key] = session;
        if (extra && extra.migrate) {
          const data = await storage.local.get(sessionMod.MIGRATED_KEY);
          const migrated = Object.assign({}, (data && data[sessionMod.MIGRATED_KEY]) || {});
          migrated[key] = Date.now();
          payload[sessionMod.MIGRATED_KEY] = migrated;
        }
        await storage.local.set(payload);
      },
    });
  }

  let writer = build();
  let unresponsive = 0;
  const handled = [];

  return {
    handled: handled,
    // Simulate a worker that cannot answer (killed mid-message): the next n
    // messages come back with chrome.runtime.lastError and no response.
    goUnresponsive: function (n) {
      unresponsive = n || 1;
    },
    // MV3 restarts the worker: same storage, empty in-memory queue.
    restart: function () {
      writer = build();
    },
    handle: function (msg, cb) {
      handled.push(msg);
      if (unresponsive > 0) {
        unresponsive -= 1;
        cb({ message: "Could not establish connection. Receiving end does not exist." }, null);
        return;
      }
      if (msg && msg.type === "writeSession") {
        writer.submit(msg.sessionKey, msg.session, msg.migrate ? { migrate: true } : null).then(
          function (outcome) {
            cb(null, {
              ok: true,
              session: outcome.session,
              written: outcome.write,
              reason: outcome.reason,
            });
          },
          function (err) {
            cb(null, {
              ok: false,
              error: { code: "session_write_failed", message: err && err.message ? err.message : String(err) },
            });
          }
        );
        return;
      }
      cb(null, { ok: false, error: { code: "unknown_message", message: String(msg && msg.type) } });
    },
  };
}

// settle waits until the fake store has no in-flight reads/writes and stops
// producing new ones for two consecutive turns.
async function settle(storage) {
  for (let i = 0; i < 80; i++) {
    await new Promise(function (r) {
      setTimeout(r, 0);
    });
    if (storage.pending === 0) {
      await new Promise(function (r) {
        setTimeout(r, 0);
      });
      if (storage.pending === 0) return;
    }
  }
}

function focus(tab) {
  globalThis.document = tab.doc;
  globalThis.chrome = tab.chrome;
  let origin = "";
  try {
    origin = new URL(tab.url).origin;
  } catch (_) {
    origin = "";
  }
  globalThis.location = { href: tab.url, origin: origin };
  if (!tab._windowListeners) tab._windowListeners = Object.create(null);
  const listeners = tab._windowListeners;
  globalThis.window = {
    scrollY: 0,
    scrollX: 0,
    innerWidth: tab.viewport ? tab.viewport.width : 1280,
    innerHeight: tab.viewport ? tab.viewport.height : 900,
    addEventListener: function (type, fn) {
      if (!listeners[type]) listeners[type] = [];
      if (listeners[type].indexOf(fn) === -1) listeners[type].push(fn);
    },
    removeEventListener: function (type, fn) {
      const list = listeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
  };
  globalThis.requestAnimationFrame = function (fn) {
    return setTimeout(fn, 0);
  };
}

function loadModules() {
  // i18n first: content.js resolves every label through it, and the bundled
  // messages must exist before the first render.
  globalThis.UllaBellaMessages = require(path.join(SRC, "i18n-messages.js"));
  globalThis.UllaBellaI18n = require(path.join(SRC, "i18n.js"));
  globalThis.UllaBella = require(path.join(SRC, "lib.js"));
  globalThis.UllaBellaQueue = require(path.join(SRC, "queue.js"));
  try {
    globalThis.UllaBellaSession = require(path.join(SRC, "session.js"));
  } catch (_) {
    delete globalThis.UllaBellaSession;
  }
  try {
    globalThis.UllaBellaConnections = require(path.join(SRC, "connections.js"));
  } catch (_) {
    delete globalThis.UllaBellaConnections;
  }
}

// defaultWorker gives a storage ONE shared worker, like a browser profile: every
// tab opened against that storage talks to the same writer.
function defaultWorker(storage) {
  if (!storage.__worker) {
    try {
      storage.__worker = makeWorker(storage);
    } catch (_) {
      return null; // pre-fix tree (no session-writer.js) — nothing to route to
    }
  }
  return storage.__worker;
}

// openTab creates one content-script instance on `url`, sharing `storage`.
// `worker` (from makeWorker) is the service worker the tab talks to; without one
// a writeSession request fails like a dead worker, which lets the pre-fix code
// (which never sends one) run against the same harness.
function openTab(opts) {
  const storage = opts.storage;
  const worker = opts.worker || defaultWorker(storage);
  const doc = makeDocument({ page: opts.page || [], title: opts.title });
  const sent = [];
  const callbacks = [];
  let onMessage = null;

  const chrome = {
    runtime: {
      onMessage: {
        addListener: function (fn) {
          onMessage = fn;
        },
      },
      sendMessage: function (msg, cb) {
        sent.push(msg);
        if (worker && msg && msg.type === "writeSession") {
          worker.handle(msg, function (lastError, response) {
            // Chrome sets chrome.runtime.lastError only for the duration of the
            // callback; a dead worker means "lastError set, no response".
            if (tabRef.current) focus(tabRef.current);
            chrome.runtime.lastError = lastError || null;
            try {
              if (typeof cb === "function") cb(response);
            } finally {
              chrome.runtime.lastError = null;
            }
          });
          return;
        }
        if (typeof cb === "function") callbacks.push(cb);
      },
      lastError: null,
    },
    storage: {
      local: storage.local,
      // Each tab gets its own view of onChanged: the listener is re-pointed at
      // THIS tab's document before it runs, the way a real per-tab content
      // script only ever sees its own DOM.
      onChanged: {
        addListener: function (fn) {
          // silentOnChanged models a tab that never receives storage events
          // (e.g. a backgrounded tab whose listener was dropped) — the truly
          // stale writer the generation rule has to stop.
          if (opts.silentOnChanged) return;
          storage.onChanged.addListener(function (changes, area) {
            if (tabRef.current) focus(tabRef.current);
            return fn(changes, area);
          });
        },
      },
    },
  };

  const tabRef = { current: null };

  const tab = {
    url: opts.url,
    doc: doc,
    chrome: chrome,
    storage: storage,
    sent: sent,
    viewport: opts.viewport || { width: 1280, height: 900 },
    _callbacks: callbacks,
    _onMessage: function () {
      return onMessage;
    },
  };

  loadModules();
  tabRef.current = tab;
  focus(tab);
  delete globalThis.__ullabellaInjected;
  delete require.cache[require.resolve(CONTENT_PATH)];
  require(CONTENT_PATH);

  tab.msg = function (m) {
    focus(tab);
    if (!onMessage) throw new Error("content script registered no message listener");
    return onMessage(m);
  };

  tab.toggle = async function () {
    tab.msg({ type: "ubToggle" });
    await settle(storage);
  };

  tab.enter = tab.toggle;

  tab.panel = function () {
    return (
      tab.doc.documentElement.children.find(function (c) {
        return c && c.classList && c.classList.contains("ullabella-panel-host");
      }) || null
    );
  };

  tab.panelPart = function (sel) {
    const p = tab.panel();
    if (!p) return null;
    return p.querySelector(sel);
  };

  tab.clickPage = function (pageEl) {
    focus(tab);
    tab.doc.dispatch("click", {
      target: pageEl,
      preventDefault: function () {},
      stopPropagation: function () {},
    });
  };

  tab.pageEl = function (tag, text, o) {
    const el = makePageEl(tag, text, o);
    tab.doc._page.push(el);
    return el;
  };

  tab.select = function (tag, text, o) {
    const el = tab.pageEl(tag, text, o);
    tab.clickPage(el);
    return el;
  };

  // openPanel materialises the panel without adding an annotation (a click on a
  // page element opens it for a new annotation; only "Add to queue" adds one).
  tab.openPanel = async function () {
    if (tab.panel()) return;
    tab.select("p", "Panel probe");
    await settle(storage);
  };

  tab.addAnnotation = async function (tag, text, instruction, o) {
    tab.select(tag, text, o);
    const input = tab.panelPart(".ullabella-input");
    if (!input) throw new Error("panel did not open");
    input.value = instruction;
    tab.panelPart(".ullabella-add").dispatch("click", {});
    await settle(storage);
  };

  tab.queueTexts = function () {
    const p = tab.panel();
    if (!p) return [];
    const list = p.querySelector(".ullabella-list");
    return list.children.map(function (item) {
      const t = item.querySelector(".ullabella-item-text");
      return t ? t.textContent : "";
    });
  };

  tab.itemResultLabels = function () {
    const p = tab.panel();
    if (!p) return [];
    const list = p.querySelector(".ullabella-list");
    return list.children.map(function (item) {
      const r = item.querySelector(".ullabella-item-result");
      return r ? r.textContent : "";
    });
  };

  tab.deleteAt = async function (i) {
    const p = tab.panel();
    const list = p.querySelector(".ullabella-list");
    const item = list.children[i];
    if (!item) throw new Error("no queue item at index " + i);
    const del = item.querySelector(".ullabella-item-del");
    item.dispatch("click", { target: del });
    await settle(storage);
  };

  tab.clearSession = async function () {
    const btn = tab.panelPart(".ullabella-clear");
    if (!btn) throw new Error("no Clear session button");
    btn.dispatch("click", {});
    await settle(storage);
    btn.dispatch("click", {});
    await settle(storage);
  };

  tab.statusText = function () {
    const s = tab.panelPart(".ullabella-status");
    return s ? s.textContent : "";
  };

  tab.sessionLabel = function () {
    const s = tab.panelPart(".ullabella-session-label");
    return s ? s.textContent : "";
  };

  tab.markers = function () {
    return tab.doc.documentElement.children.filter(function (c) {
      return c && c.classList && c.classList.contains("ullabella-marker");
    });
  };

  tab.markerLabels = function () {
    return tab.markers().map(function (m) {
      return m.textContent;
    });
  };

  tab.send = async function () {
    const btn = tab.panelPart(".ullabella-send");
    if (!btn) throw new Error("no Send button");
    btn.dispatch("click", {});
    await settle(storage);
  };

  tab.lastJob = function () {
    for (let i = sent.length - 1; i >= 0; i--) {
      if (sent[i] && sent[i].type === "submitJob") return sent[i].job;
    }
    return null;
  };

  tab.lastSentMessage = function () {
    return sent.length ? sent[sent.length - 1] : null;
  };

  tab.answerSend = function (resp) {
    const cb = callbacks.shift();
    if (typeof cb === "function") cb(resp);
  };

  // --- etapp 2 UI helpers ---------------------------------------------------

  function byClass(name) {
    return (
      tab.doc.documentElement.children.find(function (c) {
        return c && c.classList && c.classList.contains(name);
      }) || null
    );
  }

  tab.intro = function () {
    return byClass("ullabella-intro-host");
  };
  tab.hasIntro = function () {
    return !!tab.intro();
  };
  tab.introText = function (sel) {
    const host = tab.intro();
    if (!host) return null;
    const el = host.querySelector(sel);
    return el ? el.textContent : null;
  };
  tab.introInput = function () {
    const host = tab.intro();
    return host ? host.querySelector(".ullabella-intro-input") : null;
  };
  tab.writeIntro = function (text) {
    const input = tab.introInput();
    if (!input) throw new Error("no intro modal");
    input.value = text;
  };
  tab.startAnnotating = async function () {
    const host = tab.intro();
    if (!host) throw new Error("no intro modal");
    host.querySelector(".ullabella-intro-start").dispatch("click", { preventDefault() {} });
    await settle(storage);
  };
  tab.skipIntro = async function () {
    const host = tab.intro();
    if (!host) throw new Error("no intro modal");
    host.querySelector(".ullabella-intro-skip").dispatch("click", { preventDefault() {} });
    await settle(storage);
  };

  tab.descriptionText = function () {
    const el = tab.panelPart(".ullabella-desc-text");
    return el ? el.textContent : null;
  };
  tab.editDescription = async function (text) {
    const edit = tab.panelPart(".ullabella-desc-edit");
    if (!edit) throw new Error("no description edit button");
    edit.dispatch("click", { preventDefault() {} });
    const input = tab.panelPart(".ullabella-desc-input");
    input.value = text;
    tab.panelPart(".ullabella-desc-save").dispatch("click", { preventDefault() {} });
    await settle(storage);
  };

  tab.savebar = function () {
    const bar = tab.panelPart(".ullabella-savebar");
    if (!bar) return null;
    const items = [];
    const list = tab.panelPart(".ullabella-savebar-lost");
    if (list && !list.hidden && list.children) {
      for (const li of list.children) items.push(li.textContent);
    }
    const text = tab.panelPart(".ullabella-savebar-text");
    const desc = tab.panelPart(".ullabella-savebar-desc");
    return {
      hidden: !!bar.hidden,
      text: text ? text.textContent : "",
      items: items,
      lostDescription: desc && !desc.hidden ? desc.textContent : null,
      retryHidden: !!tab.panelPart(".ullabella-savebar-retry").hidden,
      readdHidden: !!tab.panelPart(".ullabella-savebar-readd").hidden,
      dismissHidden: !!tab.panelPart(".ullabella-savebar-dismiss").hidden,
    };
  };
  tab.retrySave = async function () {
    tab.panelPart(".ullabella-savebar-retry").dispatch("click", {});
    await settle(storage);
  };
  tab.readdLost = async function () {
    tab.panelPart(".ullabella-savebar-readd").dispatch("click", {});
    await settle(storage);
  };
  tab.dismissConflict = async function () {
    tab.panelPart(".ullabella-savebar-dismiss").dispatch("click", {});
    await settle(storage);
  };

  tab.comment = function () {
    return byClass("ullabella-comment");
  };
  tab.hasComment = function () {
    return !!tab.comment();
  };
  tab.commentParts = function () {
    const c = tab.comment();
    if (!c) return null;
    const result = c.querySelector(".ullabella-comment-result");
    return {
      title: c.querySelector(".ullabella-comment-title").textContent,
      body: c.querySelector(".ullabella-comment-body").textContent,
      result: result && !result.hidden ? result.textContent : null,
      role: c.attrs.role || null,
      label: c.attrs["aria-label"] || null,
      style: c.style,
    };
  };
  tab.clickMarker = async function (i) {
    const m = tab.markers()[i];
    if (!m) throw new Error("no marker at " + i);
    m.dispatch("click", { target: m, preventDefault() {}, stopPropagation() {} });
    await settle(storage);
  };
  tab.pressMarker = async function (i, key) {
    const m = tab.markers()[i];
    if (!m) throw new Error("no marker at " + i);
    m.dispatch("keydown", { key: key, target: m, preventDefault() {}, stopPropagation() {} });
    await settle(storage);
  };
  tab.closeCommentViaX = async function () {
    const c = tab.comment();
    if (!c) throw new Error("no comment open");
    c.querySelector(".ullabella-comment-close").dispatch("click", { preventDefault() {} });
    await settle(storage);
  };
  tab.markerAttrs = function (i) {
    const m = tab.markers()[i];
    if (!m) return null;
    return {
      role: m.attrs.role || null,
      tabindex: m.attrs.tabindex || null,
      label: m.attrs["aria-label"] || null,
      expanded: m.attrs["aria-expanded"] || null,
    };
  };
  tab.placeMarker = function (i, rect) {
    const m = tab.markers()[i];
    if (!m) throw new Error("no marker at " + i);
    m._rect = Object.assign({ x: rect.left, y: rect.top }, rect, {
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
    });
    return m;
  };
  tab.pressEscape = async function () {
    focus(tab);
    tab.doc.dispatch("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
    await settle(storage);
  };

  // resize changes the simulated viewport and fires the window resize listeners
  // the way a browser would.
  tab.resize = async function (width, height) {
    tab.viewport = { width: width, height: height };
    focus(tab);
    const listeners = (tab._windowListeners && tab._windowListeners.resize) || [];
    for (const fn of listeners.slice()) fn({ type: "resize" });
    await settle(storage);
  };

  return tab;
}

module.exports = {
  SRC: SRC,
  makeStorage: makeStorage,
  makeWorker: makeWorker,
  settle: settle,
  openTab: openTab,
  focus: focus,
};
