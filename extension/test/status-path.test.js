"use strict";

// Regression test for the "stuck on Working… after the backend completes" bug,
// exercised through the new annotation queue flow: select → add to queue →
// send all → done. The send response callback must not clobber "Done".

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const CONTENT_PATH = path.join(SRC, "content.js");

const PAIRED_SITE = {
  deviceId: "dev_01j7xa1b3",
  siteId: "site_01j7x9k2m",
  origin: "https://example.test",
  displayName: "Example Test",
  relayUrl: "http://relay.test:8787",
  deviceCredential: "ubd_test",
};

// Minimal fake element: querySelector memoizes one child per selector so
// repeated lookups return the same fake node; listeners are recorded by type.
function makeEl(tag) {
  const classList = [];
  classList.add = (c) => { if (!classList.includes(c)) classList.push(c); };
  classList.remove = (c) => { const i = classList.indexOf(c); if (i >= 0) classList.splice(i, 1); };
  classList.contains = (c) => classList.includes(c);

  const children = new Map();
  const listeners = {};
  const el = {
    tagName: (tag || "div").toUpperCase(),
    nodeType: 1,
    id: "",
    style: {},
    className: "",
    innerHTML: "",
    innerText: "",
    textContent: "",
    value: "",
    type: "",
    disabled: false,
    parentElement: null,
    children: [],
    classList,
    _listeners: listeners,
    closest() { return null; },
    getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 30 }; },
    isConnected: true,
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
    remove() {},
    setAttribute() {},
    focus() {},
    addEventListener(type, fn) { listeners[type] = fn; },
    querySelector(sel) {
      if (!children.has(sel)) children.set(sel, makeEl("span"));
      return children.get(sel);
    },
  };
  return el;
}

function makeShim() {
  const documentElement = makeEl("html");
  const clickListeners = [];
  const document = {
    title: "Tjänster — Example Test",
    documentElement,
    addEventListener(type, fn) { if (type === "click") clickListeners.push(fn); },
    removeEventListener() {},
    createElement(tag) { return makeEl(tag); },
  };
  let onMessage = null;
  let sendCallback = null;
  let sentMsg = null;
  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { onMessage = fn; } },
      sendMessage(_msg, cb) { sentMsg = _msg; sendCallback = cb; },
    },
    storage: {
      local: {
        get: async () => ({ site: PAIRED_SITE }),
        set: async () => {},
      },
    },
  };
  return {
    document,
    chrome,
    getOnMessage: () => onMessage,
    getClickHandlers: () => clickListeners,
    getSendCallback: () => sendCallback,
    getSentMessage: () => sentMsg,
  };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function load() {
  const shim = makeShim();
  globalThis.UllaBellaMessages = require(path.join(SRC, "i18n-messages.js"));
  globalThis.UllaBellaI18n = require(path.join(SRC, "i18n.js"));
  globalThis.UllaBella = require(path.join(SRC, "lib.js"));
  globalThis.UllaBellaQueue = require(path.join(SRC, "queue.js"));
  globalThis.UllaBellaSession = require(path.join(SRC, "session.js"));
  globalThis.UllaBellaConnections = require(path.join(SRC, "connections.js"));
  globalThis.document = shim.document;
  globalThis.chrome = shim.chrome;
  globalThis.location = { href: PAIRED_SITE.origin + "/services", origin: PAIRED_SITE.origin };
  globalThis.window = { scrollY: 0, scrollX: 0 };

  delete require.cache[require.resolve(CONTENT_PATH)];
  delete globalThis.__ullabellaInjected;
  require(CONTENT_PATH); // runs the IIFE, registers the runtime message listener

  const onMessage = shim.getOnMessage();
  assert.ok(onMessage, "content script should register a runtime message listener");
  onMessage({ type: "ubToggle" }); // -> async toggle() -> resolveSite() -> enter()
  await flush(); // let site resolution settle before asserting the click handler

  const handlers = shim.getClickHandlers();
  assert.equal(handlers.length, 1, "enter() should register one capture click handler");
  const onClick = handlers[0];

  // Select an H1 -> openPanelForNew() -> panel appears.
  const h1 = makeEl("h1");
  h1.innerText = "Tjänster";
  onClick({ target: h1, preventDefault() {}, stopPropagation() {} });

  const host = shim.document.documentElement.children.find((c) =>
    c.className.includes("ullabella-panel-host")
  );
  assert.ok(host, "panel host should be appended after selection");
  const input = host.querySelector(".ullabella-input");
  const add = host.querySelector(".ullabella-add")._listeners.click;
  const send = host.querySelector(".ullabella-send")._listeners.click;
  assert.equal(typeof add, "function", "Add button should be wired to addOrSave()");
  assert.equal(typeof send, "function", "Send button should be wired to sendAll()");

  return { shim, host, input, add, send, onMessage };
}

function statusText(host) {
  return host.querySelector(".ullabella-status").textContent;
}

// progressTitle reads the working-progress indicator title. showProgress sets it
// to "Hermes is working…" for a working/accepted status; the .ullabella-status
// text is cleared at that point (the progress indicator owns the "working" UI).
function progressTitle(host) {
  return host.querySelector(".ullabella-progress").querySelector(".ullabella-progress-title").textContent;
}

test("queue flow reaches Done and stays Done after the send response", async () => {
  const { shim, host, input, add, send, onMessage } = await load();

  // Add one annotation to the queue.
  input.value = "Change this heading to Our Services";
  add();

  // Send all.
  send();
  assert.ok(statusText(host).startsWith("Sending"), "should show Sending… right after Send");

  // Background worker posts the job, then reports working. The working state is
  // shown by the progress indicator (not the .ullabella-status text, which is
  // cleared) — this changed with the Task 2 progress UI.
  onMessage({ type: "ubJobStatus", status: "working" });
  assert.equal(progressTitle(host), "Hermes is working…", "should show the working progress indicator");

  // Backend completes; the worker pushes done.
  const annId = shim.getSentMessage().job.annotations[0].annotationId;
  onMessage({ type: "ubJobStatus", status: "done", summary: "Changed heading", annotationResults: [
    { annotationId: annId, status: "done", summary: "Changed heading" },
  ] });
  const doneText = statusText(host);
  assert.ok(!doneText.startsWith("Working"), "should show a terminal status after done");

  // The runtime sendMessage response callback fires AFTER the terminal status.
  // It must not touch the panel. (Regression: it used to reset "Working…".)
  const sendCallback = shim.getSendCallback();
  assert.equal(typeof sendCallback, "function", "send() should pass a response callback");
  sendCallback({ ok: true });

  assert.equal(statusText(host), doneText, "send response must not clobber the terminal status");
});

test("a one-annotation round uses the job's verified result (no annotationResults)", async () => {
  const { host, input, add, send, onMessage } = await load();

  input.value = "Change this heading to Our Services";
  add();
  send();

  // The adapter reports annotationResults for BATCHES only: a single
  // annotation comes back with the job-level outcome. The panel must show that
  // verified success, not "results unavailable" / "?".
  onMessage({
    type: "ubJobStatus",
    status: "done",
    summary: "Changed heading",
    verification: { status: "passed", summary: "Changed heading" },
  });

  // The roll-up is derived from the per-annotation result, so this is the
  // assertion that the single annotation was marked done rather than unknown.
  // (The ✓ mark itself is checked in the real-browser run: the harness's fake
  // list does not rebuild on innerHTML = "".)
  assert.equal(statusText(host), "1 of 1 completed successfully");
});

test("working message with activity shows the agent-activity line", async () => {
  const { host, input, add, send, onMessage } = await load();

  input.value = "Change this heading";
  add();
  send();

  const activityAt = new Date(Date.now() - 18000).toISOString();
  onMessage({
    type: "ubJobStatus",
    status: "working",
    activity: { kind: "using_tools", activityAt: activityAt, checkedAt: new Date().toISOString() },
  });

  const prog = host.querySelector(".ullabella-progress");
  const activityEl = prog.querySelector(".ullabella-progress-activity");
  assert.equal(activityEl.textContent, "Activity: Executing tools");
  const agentEl = prog.querySelector(".ullabella-progress-agent");
  assert.match(agentEl.textContent, /^Last agent activity: /);
});

test("working message without activity shows the neutral unavailable state", async () => {
  const { host, onMessage } = await load();

  onMessage({ type: "ubJobStatus", status: "working" });

  const prog = host.querySelector(".ullabella-progress");
  const activityEl = prog.querySelector(".ullabella-progress-activity");
  assert.equal(activityEl.textContent, "Agent activity unavailable");
});

// --- annotation result reporting (Task 5.1) --------------------------------
// Root cause: sendAll rebuilt each annotation with a FRESH annotationId, so the
// backend results (keyed by the sent ids) never matched the queue ids and every
// annotation rendered as "unknown". The fix reuses the queue's stable id.

test("sendAll reuses the queue annotationId in the submitted job", async () => {
  const { shim, host, input, add, send } = await load();

  const realNewId = globalThis.UllaBella.newId;
  let seq = 0;
  globalThis.UllaBella.newId = (prefix) => prefix + "_" + seq++;

  try {
    input.value = "Change this heading";
    add();
    send();

    const job = shim.getSentMessage().job;
    assert.equal(job.annotations.length, 1);
    assert.equal(job.annotations[0].annotationId, "ann_0",
      "the submitted job must reuse the queue's stable annotationId, not a fresh one");
  } finally {
    globalThis.UllaBella.newId = realNewId;
  }
});

function addThree(l) {
  const onClick = l.shim.getClickHandlers()[0];
  const rows = [["h1", "Change heading one"], ["h2", "Change heading two"], ["h3", "Change heading three"]];
  for (const [tag, instr] of rows) {
    const el = makeEl(tag);
    el.innerText = tag;
    onClick({ target: el, preventDefault() {}, stopPropagation() {} });
    l.input.value = instr;
    l.add();
  }
}

test("done with three matching results shows 3 of 3", async () => {
  const l = await load();
  addThree(l);
  l.send();

  const job = l.shim.getSentMessage().job;
  const results = job.annotations.map((a) => ({ annotationId: a.annotationId, status: "done", summary: "ok" }));
  l.onMessage({ type: "ubJobStatus", status: "done", summary: "3 of 3", annotationResults: results });

  assert.equal(statusText(l.host), "3 of 3 completed successfully");
});

test("done with no matching results shows the neutral unavailable summary", async () => {
  const l = await load();
  addThree(l);
  l.send();

  l.onMessage({ type: "ubJobStatus", status: "done", summary: "x", annotationResults: [] });

  assert.equal(statusText(l.host), "Results unavailable for 3 annotations");
});

test("done with two matches and one unknown shows the partial summary", async () => {
  const l = await load();
  addThree(l);
  l.send();

  const job = l.shim.getSentMessage().job;
  const results = job.annotations.slice(0, 2).map((a) => ({ annotationId: a.annotationId, status: "done", summary: "ok" }));
  l.onMessage({ type: "ubJobStatus", status: "done", summary: "2 of 3", annotationResults: results });

  assert.equal(statusText(l.host), "2 completed \u00b7 1 result unknown");
});
