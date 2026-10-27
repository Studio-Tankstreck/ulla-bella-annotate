"use strict";

// Concurrency regression suite for the session store (review round 1).
//
// The two reviewed defects:
//   1. `writeSession()` was a read-merge-write in the CONTENT SCRIPT, so two
//      tabs that read the same stored document could each write a full
//      document; the later write won and the earlier tab's tombstone was gone.
//   2. `previousSessionId` protected one clear generation only; after two
//      clears a stale session was treated as a "concurrent creation" and merged
//      its old annotations back.
//
// These tests drive the real content scripts through the real session writer
// (makeWorker) against one shared, asynchronous store, hold writes to force
// "both tabs read before either writes", and always check the STORED document
// plus a freshly opened tab.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { makeStorage, makeWorker, settle, openTab } = require("./support/tab");
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

function ann(id, instruction, extra) {
  return Object.assign(
    {
      annotationId: id,
      instruction: instruction,
      target: { url: URL_UNDER_TEST, elementType: "h1", visibleText: instruction, selector: "h1" },
    },
    extra || {}
  );
}

function storedSession(storage) {
  return storage.raw()[KEY];
}

function storedIds(storage) {
  const s = storedSession(storage);
  return s ? s.annotations.map((a) => a.annotationId) : null;
}

// seedSession writes a session document exactly as a previous tab would have,
// then returns the storage/worker pair plus a factory for tabs.
function seedSession(annotations, extra) {
  const storage = makeStorage();
  const base = S.empty({
    siteId: SITE.siteId,
    siteName: SITE.displayName,
    pageId: pageId(URL_UNDER_TEST),
    pageUrl: URL_UNDER_TEST,
  });
  const sessionDoc = Object.assign(S.withAnnotations(base, annotations), extra || {});
  storage.seed({ site: SITE, [KEY]: sessionDoc });
  const worker = makeWorker(storage);
  return {
    storage: storage,
    worker: worker,
    tab: function (url) {
      return openTab({ storage: storage, worker: worker, url: url || URL_UNDER_TEST });
    },
  };
}

function textsOf(list) {
  return list.map((a) => a.instruction);
}

// --- defect 1: concurrent writers ------------------------------------------

for (const order of ["delete-first", "add-first"]) {
  test(`a deletion survives a concurrent addition from another tab (${order})`, async () => {
    const seeded = seedSession([ann("ann_old", "Old heading"), ann("ann_keep", "Keep heading")]);
    const tabA = seeded.tab();
    const tabB = seeded.tab();
    await tabA.toggle();
    await tabB.toggle();
    await tabA.openPanel();
    await tabB.openPanel();
    assert.deepEqual(tabA.queueTexts(), ["Old heading", "Keep heading"]);

    // Hold every write so BOTH tabs have read the stored document before either
    // write lands — the exact interleaving that used to lose the deletion.
    seeded.storage.hold();

    const act = async (which) => {
      if (which === "delete") return tabA.deleteAt(0);
      return tabB.addAnnotation("h2", "Priser", "Added by B");
    };

    if (order === "delete-first") {
      await act("delete");
      await act("add");
    } else {
      await act("add");
      await act("delete");
    }

    seeded.storage.release();
    await settle(seeded.storage);

    const stored = storedSession(seeded.storage);
    assert.ok(stored, "the session must be stored");
    assert.deepEqual(
      stored.annotations.map((a) => a.instruction).sort(),
      ["Added by B", "Keep heading"],
      "the deleted annotation must not be stored again"
    );
    assert.ok(stored.deleted.ann_old, "the tombstone must be stored");

    // All the original tabs are gone; a new tab must see the same truth.
    const fresh = seeded.tab();
    await fresh.toggle();
    await fresh.openPanel();
    assert.deepEqual(fresh.queueTexts().sort(), ["Added by B", "Keep heading"]);
  });
}

test("a deletion survives a concurrent addition AND a status update", async () => {
  const seeded = seedSession(
    [ann("ann_old", "Old heading", { result: { status: "processing" } }), ann("ann_keep", "Keep heading", { result: { status: "processing" } })],
    { job: { jobId: "job_1", status: "sending", siteId: SITE.siteId, submittedAt: new Date().toISOString(), annotationIds: ["ann_old", "ann_keep"] } }
  );
  const tabA = seeded.tab();
  const tabB = seeded.tab();
  await tabA.toggle();
  await tabB.toggle();
  await tabA.openPanel();
  await tabB.openPanel();

  seeded.storage.hold();
  await tabA.deleteAt(0);
  await tabB.addAnnotation("h2", "Priser", "Added by B");
  tabB.msg({
    type: "ubJobStatus",
    status: "done",
    jobId: "job_1",
    annotationResults: [
      { annotationId: "ann_old", status: "done", summary: "ok" },
      { annotationId: "ann_keep", status: "done", summary: "ok" },
    ],
  });
  await settle(seeded.storage);
  seeded.storage.release();
  await settle(seeded.storage);

  const stored = storedSession(seeded.storage);
  const ids = stored.annotations.map((a) => a.annotationId);
  assert.equal(ids.length, 2, "keep + the annotation B added");
  assert.ok(ids.includes("ann_keep"), "the surviving annotation stays");
  assert.ok(!ids.includes("ann_old"), "the deleted annotation must not come back through a status update");
  assert.ok(stored.deleted.ann_old, "the tombstone stays");
  assert.equal(
    stored.annotations.find((a) => a.annotationId === "ann_keep").result.status,
    "done",
    "the status update still landed on the surviving annotation"
  );
});

test("a clear is not undone by a concurrent old write", async () => {
  const seeded = seedSession([ann("ann_old", "Old heading"), ann("ann_keep", "Keep heading")]);
  const tabA = seeded.tab();
  const tabB = seeded.tab();
  await tabA.toggle();
  await tabB.toggle();
  await tabA.openPanel();
  await tabB.openPanel();

  seeded.storage.hold();
  await tabA.clearSession();
  await tabB.addAnnotation("h2", "Priser", "Added by B");
  seeded.storage.release();
  await settle(seeded.storage);

  const stored = storedSession(seeded.storage);
  assert.deepEqual(stored.annotations, [], "a cleared session stays cleared");
  assert.ok(stored.generation >= 1, "the clear advanced the slot's generation");
  assert.ok(stored.clearedAt);

  const fresh = seeded.tab();
  await fresh.toggle();
  await fresh.openPanel();
  assert.deepEqual(fresh.queueTexts(), []);
});

// --- defect 2: stale sessions after (several) clears ------------------------

test("two clears, then a write from the original session cannot resurrect it", async () => {
  const original = S.withAnnotations(
    S.empty({ siteId: "test", pageId: "/" }),
    [ann("ann_old", "old")]
  );
  const once = S.clear(original);
  const twice = S.clear(once);
  const result = S.mergeWrite(twice, original);
  assert.equal(result.write, false, "a pre-clear view must be refused");
  assert.equal(result.reason, "stale-generation");
  assert.deepEqual(result.session.annotations, []);
  assert.equal(result.session.sessionId, twice.sessionId);
});

test("a session cleared twice refuses writes from any older generation", () => {
  const original = S.withAnnotations(
    S.empty({ siteId: "test", pageId: "/" }),
    [ann("ann_old", "old"), ann("ann_keep", "keep")]
  );
  const once = S.clear(original);
  const twice = S.clear(S.withAnnotations(once, [ann("ann_second", "second")]));

  for (const [name, stale] of [
    ["original", original],
    ["first clear", once],
  ]) {
    const r = S.mergeWrite(twice, stale);
    assert.equal(r.write, false, `${name} must not write after two clears`);
    assert.deepEqual(r.session.annotations, [], `${name} must not resurrect anything`);
    assert.equal(r.session.generation, twice.generation);
  }
});

test("a tab that never saw two clears cannot write the session back", async () => {
  const seeded = seedSession([ann("ann_old", "Old heading")]);
  // This tab never receives storage events, so its document stays at the
  // generation it loaded — a genuinely stale writer.
  const stale = openTab({
    storage: seeded.storage,
    worker: seeded.worker,
    url: URL_UNDER_TEST,
    silentOnChanged: true,
  });
  await stale.toggle();
  await stale.openPanel();

  const tabA = seeded.tab();
  await tabA.toggle();
  await tabA.openPanel();
  await tabA.clearSession(); // clear #1
  await tabA.addAnnotation("h2", "Priser", "After the first clear");
  await tabA.clearSession(); // clear #2

  assert.equal(storedSession(seeded.storage).generation, 2);
  assert.deepEqual(storedSession(seeded.storage).annotations, []);

  // The stale tab now writes its pre-clear document, including a new annotation.
  await stale.addAnnotation("h3", "Kontakt", "Added by the stale tab");
  await settle(seeded.storage);

  const stored = storedSession(seeded.storage);
  assert.ok(!stored.annotations.some((a) => a.annotationId === "ann_old"), "old annotation stays gone");
  assert.deepEqual(
    stored.annotations,
    [],
    "a pre-clear generation cannot write into a session cleared twice"
  );

  const fresh = seeded.tab();
  await fresh.toggle();
  await fresh.openPanel();
  assert.deepEqual(fresh.queueTexts(), []);
});

// A tab that DID see the clear is no longer stale, and may keep working.
test("a tab that adopted the clear can add new work to the cleared session", async () => {
  const seeded = seedSession([ann("ann_old", "Old heading")]);
  const tabA = seeded.tab();
  const tabB = seeded.tab();
  await tabA.toggle();
  await tabB.toggle();
  await tabA.openPanel();
  await tabB.openPanel();

  await tabA.clearSession();
  await settle(seeded.storage);

  await tabB.addAnnotation("h2", "Priser", "Fresh work after the clear");
  await settle(seeded.storage);

  const stored = storedSession(seeded.storage);
  assert.ok(!stored.annotations.some((a) => a.annotationId === "ann_old"), "the old annotation stays gone");
  assert.deepEqual(
    stored.annotations.map((a) => a.instruction),
    ["Fresh work after the clear"],
    "new work in the new session is kept"
  );
});

// --- concurrent first creation ---------------------------------------------

test("two tabs creating the same empty session at once keep both annotations", async () => {
  const storage = makeStorage();
  storage.seed({ site: SITE });
  const worker = makeWorker(storage);
  const tabA = openTab({ storage: storage, worker: worker, url: URL_UNDER_TEST });
  const tabB = openTab({ storage: storage, worker: worker, url: URL_UNDER_TEST });
  await tabA.toggle();
  await tabB.toggle();

  storage.hold();
  await tabA.addAnnotation("h1", "Tjänster", "A: change the heading");
  await tabB.addAnnotation("h2", "Priser", "B: change the pricing heading");
  storage.release();
  await settle(storage);

  const stored = storedSession(storage);
  assert.ok(stored, "one session document is stored");
  assert.deepEqual(
    textsOf(stored.annotations).sort(),
    ["A: change the heading", "B: change the pricing heading"],
    "neither tab's first annotation may be lost"
  );
  assert.deepEqual(Object.keys(stored.deleted), [], "nothing was deleted");
  assert.equal(stored.generation, 0);

  const fresh = openTab({ storage: storage, worker: worker, url: URL_UNDER_TEST });
  await fresh.toggle();
  await fresh.openPanel();
  assert.deepEqual(fresh.queueTexts().sort(), ["A: change the heading", "B: change the pricing heading"]);
});

// --- service worker restarts ------------------------------------------------

test("a deletion acknowledged before a worker restart stays deleted", async () => {
  const seeded = seedSession([ann("ann_old", "Old heading"), ann("ann_keep", "Keep heading")]);
  const tabA = seeded.tab();
  const tabB = seeded.tab();
  await tabA.toggle();
  await tabB.toggle();
  await tabA.openPanel();
  await tabB.openPanel();

  await tabA.deleteAt(0);
  assert.ok(storedSession(seeded.storage).deleted.ann_old, "the deletion is stored before the restart");

  // MV3 kills and restarts the worker: new writer instance, empty queue.
  seeded.worker.restart();

  // The stale tab now writes its pre-deletion document.
  await tabB.addAnnotation("h3", "Kontakt", "Added by B");
  await settle(seeded.storage);

  const stored = storedSession(seeded.storage);
  assert.ok(!stored.annotations.some((a) => a.annotationId === "ann_old"), "the restart must not resurrect it");
  assert.ok(stored.deleted.ann_old);
  assert.ok(stored.annotations.some((a) => a.instruction === "Added by B"));

  const fresh = seeded.tab();
  await fresh.toggle();
  await fresh.openPanel();
  assert.deepEqual(fresh.queueTexts().sort(), ["Added by B", "Keep heading"]);
});

test("a write that the worker could not answer is retried, not lost", async () => {
  const seeded = seedSession([ann("ann_old", "Old heading")]);
  const tab = seeded.tab();
  await tab.toggle();
  await tab.openPanel();

  // The worker is killed mid-message once: chrome.runtime.lastError, no reply.
  seeded.worker.goUnresponsive(1);
  await tab.deleteAt(0);
  // The retry is delayed (40 ms), so wait past it before reading the store.
  await new Promise((r) => setTimeout(r, 200));
  await settle(seeded.storage);

  const stored = storedSession(seeded.storage);
  assert.ok(stored.deleted.ann_old, "the retried write reached the store");
  assert.deepEqual(stored.annotations, []);

  const fresh = seeded.tab();
  await fresh.toggle();
  await fresh.openPanel();
  assert.deepEqual(fresh.queueTexts(), []);
});
