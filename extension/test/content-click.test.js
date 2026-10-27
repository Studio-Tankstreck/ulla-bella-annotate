"use strict";

// Regression test for the Task 08 "dead panel buttons" bug.
//
// content.js registers a capture-phase click handler that, in the buggy
// version, called preventDefault()/stopPropagation() on EVERY click before
// checking whether the click landed inside Ulla-Bella's own UI. That swallowed
// clicks aimed at the panel buttons (Send / Cancel / close) before their own
// listeners could fire.
//
// This test loads the real content.js against a minimal DOM/extension shim,
// enters annotation mode, and drives the capture-phase click handler directly
// to assert the guard ordering:
//   - a click inside .ullabella-ui is NOT intercepted (buttons work), and
//   - a click on a normal page element IS still intercepted.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const CONTENT_PATH = path.join(SRC, "content.js");

// The paired Site the shim pretends to be running on. content.js reads this
// from chrome.storage.local (the release behavior) instead of the old
// dev-only config.js.
const PAIRED_SITE = {
  deviceId: "dev_01j7xa1b3",
  siteId: "site_01j7x9k2m",
  origin: "https://example.test",
  displayName: "Example Test",
  relayUrl: "http://relay.test:8787",
  deviceCredential: "ubd_test",
};

// A stub node for the parts of the DOM content.js touches while it builds its
// own UI (the intro card, the panel, the save status). Deep enough that any
// querySelector call resolves to another stub.
function makeStubNode() {
  const node = {
    style: {},
    value: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute() {},
    appendChild() {},
    addEventListener() {},
    focus() {},
    querySelector() {
      return makeStubNode();
    },
  };
  return node;
}

// Minimal shim covering only what content.js touches while loading, entering
// annotation mode, and handling a click. Deliberately small.
function makeShim() {
  const clickListeners = [];
  const document = {
    addEventListener(type, fn) {
      if (type === "click") clickListeners.push(fn);
    },
    removeEventListener() {},
    createElement() {
      return makeStubNode();
    },
    documentElement: {
      style: {},
      appendChild() {},
      removeChild() {},
      querySelector() {
        return null;
      },
    },
  };
  let onMessage = null;
  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { onMessage = fn; } },
      sendMessage(_msg, cb) {
        if (typeof cb === "function") cb({ ok: true, session: null });
      },
      lastError: null,
    },
    storage: {
      local: { get: async () => ({ site: PAIRED_SITE }) },
    },
  };
  return {
    document,
    chrome,
    getOnMessage: () => onMessage,
    getClickHandlers: () => clickListeners,
  };
}

// Load content.js fresh, toggle annotation mode on, and return the registered
// capture-phase click handler.
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadClickHandler() {
  const shim = makeShim();

  // lib.js is UMD: under require() it exports on module.exports and does NOT
  // set globals, so expose it the way the manifest would.
  globalThis.UllaBellaMessages = require(path.join(SRC, "i18n-messages.js"));
  globalThis.UllaBellaI18n = require(path.join(SRC, "i18n.js"));
  globalThis.UllaBella = require(path.join(SRC, "lib.js"));
  globalThis.UllaBellaQueue = require(path.join(SRC, "queue.js"));
  globalThis.UllaBellaSession = require(path.join(SRC, "session.js"));
  globalThis.UllaBellaConnections = require(path.join(SRC, "connections.js"));
  globalThis.document = shim.document;
  globalThis.chrome = shim.chrome;
  globalThis.location = {
    href: PAIRED_SITE.origin + "/services",
    origin: PAIRED_SITE.origin,
  };

  delete require.cache[require.resolve(CONTENT_PATH)];
  delete globalThis.__ullabellaInjected; // reset double-injection guard for a fresh load
  require(CONTENT_PATH); // runs the IIFE, registers the runtime message listener

  const onMessage = shim.getOnMessage();
  assert.ok(onMessage, "content script should register a runtime message listener");
  onMessage({ type: "ubToggle" }); // -> async toggle() -> resolveSite() -> enter()
  await flush(); // let the storage read + site resolution settle

  const handlers = shim.getClickHandlers();
  assert.equal(handlers.length, 1, "enter() should register one capture click handler");
  return handlers[0];
}

function fakeEvent(target) {
  const calls = { preventDefault: 0, stopPropagation: 0 };
  return {
    target,
    preventDefault() { calls.preventDefault += 1; },
    stopPropagation() { calls.stopPropagation += 1; },
    calls,
  };
}

test("clicks inside .ullabella-ui are not intercepted", async () => {
  const onClick = await loadClickHandler();
  const evt = fakeEvent({ closest: () => ({ __ullabellaUi: true }) });
  onClick(evt);
  assert.equal(evt.calls.preventDefault, 0, "own-UI click must not be preventDefault'd");
  assert.equal(evt.calls.stopPropagation, 0, "own-UI click must not be stopPropagation'd");
});

test("clicks on normal page elements are still intercepted", async () => {
  const onClick = await loadClickHandler();
  // A skip tag (body) proves preventDefault/stopPropagation fire before the
  // selectable check, without needing the full capture() DOM surface.
  const evt = fakeEvent({ closest: () => null, nodeType: 1, tagName: "BODY" });
  onClick(evt);
  assert.equal(evt.calls.preventDefault, 1, "page click must still be preventDefault'd");
  assert.equal(evt.calls.stopPropagation, 1, "page click must still be stopPropagation'd");
});
