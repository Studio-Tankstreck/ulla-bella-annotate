"use strict";

// Correction pass (review round 2) regression suite.
//
// 1. A REFUSED session description used to vanish silently: the generation check
//    only looked at annotations, so a description typed into a tab whose session
//    had been cleared elsewhere was replaced without a word.
// 2. The marker comment popover was clamped at the top edge but had no height
//    limit, so on a short viewport its bottom (and its controls) could end up
//    off-screen.
//
// The geometry here is simulated by the harness (fake rects that honour
// max-height); real-browser geometry is still a manual check.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { makeStorage, makeWorker, settle, openTab } = require("./support/tab");
const { setDefaultRect, resetDefaultRect } = require("./support/fake-dom");
const S = require(path.join(__dirname, "..", "src", "session.js"));
const pageId = require(path.join(__dirname, "..", "src", "queue.js")).pageId;

const ORIGIN = "https://example.test";
const URL_UNDER_TEST = ORIGIN + "/tjanster";
const SITE = {
  deviceId: "dev_1",
  siteId: "site_alpha",
  origin: ORIGIN,
  displayName: "Example Test",
  relayUrl: "http://relay.test:8787",
  deviceCredential: "ubd_test",
};
const KEY = S.storageKey("http://relay.test:8787|" + SITE.siteId, pageId(URL_UNDER_TEST));

function ann(id, instruction) {
  return {
    annotationId: id,
    instruction: instruction,
    target: { url: URL_UNDER_TEST, elementType: "h1", visibleText: instruction, selector: "h1" },
  };
}

function storedSession(storage) {
  return storage.raw()[KEY];
}

function setup(annotations, extra) {
  const storage = makeStorage();
  storage.seed({ site: SITE });
  if (annotations || extra) {
    const base = S.empty({
      siteId: SITE.siteId,
      siteName: SITE.displayName,
      pageId: pageId(URL_UNDER_TEST),
      pageUrl: URL_UNDER_TEST,
    });
    storage.seed({ site: SITE, [KEY]: Object.assign(S.withAnnotations(base, annotations || []), extra || {}) });
  }
  const worker = makeWorker(storage);
  return {
    storage: storage,
    worker: worker,
    tab: function (opts) {
      return openTab(Object.assign({ storage: storage, worker: worker, url: URL_UNDER_TEST }, opts || {}));
    },
    silent: function (opts) {
      return openTab(
        Object.assign({ storage: storage, worker: worker, url: URL_UNDER_TEST, silentOnChanged: true }, opts || {})
      );
    },
  };
}

// --- 1. a refused description ---------------------------------------------

test("a refused session description is preserved, explained and can be added back", async () => {
  const s = setup([], { intro: "skipped" });
  const stale = s.silent();
  await stale.toggle();
  await stale.openPanel();
  assert.equal(stale.descriptionText(), "No session description yet.");

  const other = s.tab();
  await other.toggle();
  await other.openPanel();
  await other.clearSession(); // the session is cleared elsewhere

  // The stale tab types and saves a description into the cleared session.
  await stale.editDescription("Important newly typed context");

  // Nothing was restored automatically...
  assert.equal(storedSession(s.storage).description, "", "the cleared session stays cleared");
  // ...but the text is not gone: it is readable, explained and re-addable.
  const bar = stale.savebar();
  assert.ok(bar, "a save bar exists");
  assert.equal(bar.hidden, false, "the refused description is reported");
  assert.match(bar.text, /cleared in another tab/i);
  assert.match(bar.text, /description/i);
  assert.equal(bar.lostDescription, "Important newly typed context", "the user's text is preserved verbatim");
  assert.equal(bar.readdHidden, false, "the user can add it back explicitly");
  // The visible description still shows the CURRENT (cleared) session.
  assert.equal(stale.descriptionText(), "No session description yet.");

  await stale.readdLost();
  assert.equal(
    storedSession(s.storage).description,
    "Important newly typed context",
    "the explicit action puts the text into the current session"
  );
  assert.equal(stale.savebar().hidden, true);
});

test("a refused description AND refused annotations are both preserved and re-addable", async () => {
  const s = setup([ann("ann_1", "Existing change")], { intro: "skipped", description: "Original purpose" });
  const stale = s.silent();
  await stale.toggle();
  await stale.openPanel();
  await stale.addAnnotation("h2", "Priser", "Stale tab work");

  const other = s.tab();
  await other.toggle();
  await other.openPanel();
  await other.clearSession();

  await stale.editDescription("Newly typed context after the clear");

  const bar = stale.savebar();
  assert.equal(bar.hidden, false);
  assert.equal(bar.lostDescription, "Newly typed context after the clear");
  assert.deepEqual(
    bar.items.sort(),
    ["Existing change", "Stale tab work"].sort(),
    "the annotations are still listed"
  );
  assert.deepEqual(storedSession(s.storage).annotations, [], "nothing restored automatically");
  assert.equal(storedSession(s.storage).description, "");

  await stale.readdLost();
  const after = storedSession(s.storage);
  assert.equal(after.description, "Newly typed context after the clear");
  assert.deepEqual(after.annotations.map((a) => a.instruction).sort(), ["Existing change", "Stale tab work"].sort());
});

test("unsaved text in an open description editor survives an update from another tab", async () => {
  const s = setup([ann("ann_1", "Existing change")], { intro: "skipped", description: "Original purpose" });
  const tabA = s.tab();
  await tabA.toggle();
  await tabA.openPanel();

  tabA.panelPart(".ullabella-desc-edit").dispatch("click", { preventDefault() {} });
  const input = tabA.panelPart(".ullabella-desc-input");
  input.value = "Half-written text that is not saved yet";

  // Another tab changes the description; tab A receives a storage update.
  const tabB = s.tab();
  await tabB.toggle();
  await tabB.openPanel();
  await tabB.editDescription("Changed elsewhere");
  await settle(s.storage);

  assert.equal(
    tabA.panelPart(".ullabella-desc-input").value,
    "Half-written text that is not saved yet",
    "the open editor keeps the unsaved text"
  );
  assert.equal(tabA.panelPart(".ullabella-desc-editor").hidden, false, "the editor stays open");
  assert.equal(tabA.panelPart(".ullabella-desc-edit").textContent, "Edit description");
});

// --- 2. the comment popover must fit the viewport height -------------------

test("the comment panel is limited to the available height and its controls stay reachable", async () => {
  const s = setup([ann("ann_1", "x".repeat(1200))], { intro: "skipped" });
  // A very tall comment box: the fake DOM honours max-height, like CSS does.
  setDefaultRect({ left: 20, top: 40, width: 300, height: 600 });
  try {
    const tab = s.tab({ viewport: { width: 360, height: 240 } });
    await tab.toggle();
    tab.placeMarker(0, { left: 40, top: 200, width: 20, height: 20 });
    await tab.clickMarker(0);

    const parts = tab.commentParts();
    assert.ok(parts, "the comment is open");
    const maxHeight = parseInt(parts.style.maxHeight, 10);
    assert.equal(maxHeight, 240 - 16, "the panel may not exceed the viewport minus the 8px margin");

    const top = parseInt(parts.style.top, 10);
    const height = Math.min(600, maxHeight);
    assert.ok(top >= 8, "the panel starts inside the top edge");
    assert.ok(top + height <= 240 - 8, "the whole panel fits above the bottom edge");
  } finally {
    resetDefaultRect();
  }
});

test("the comment panel re-fits when the window shrinks", async () => {
  const s = setup([ann("ann_1", "x".repeat(600))], { intro: "skipped" });
  setDefaultRect({ left: 20, top: 40, width: 300, height: 500 });
  try {
    const tab = s.tab({ viewport: { width: 400, height: 800 } });
    await tab.toggle();
    tab.placeMarker(0, { left: 40, top: 100, width: 20, height: 20 });
    await tab.clickMarker(0);
    assert.equal(parseInt(tab.commentParts().style.maxHeight, 10), 800 - 16);

    await tab.resize(400, 300);
    const parts = tab.commentParts();
    assert.equal(parseInt(parts.style.maxHeight, 10), 300 - 16, "the panel re-fits after a resize");
    const top = parseInt(parts.style.top, 10);
    assert.ok(top + Math.min(500, 300 - 16) <= 300 - 8, "and stays inside the shorter viewport");
  } finally {
    resetDefaultRect();
  }
});
