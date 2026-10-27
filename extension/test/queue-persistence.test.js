"use strict";

// Regression tests for the reported bug: "annotations I removed with × come
// back, days later". These drive the REAL content script (two independent
// instances = two tabs) against one shared, asynchronous chrome.storage.local.

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeStorage, openTab } = require("./support/tab");

const ORIGIN = "https://example.test";
const URL_UNDER_TEST = ORIGIN + "/tjanster";
const URL_OTHER_PAGE = ORIGIN + "/priser";
const SITE = {
  deviceId: "dev_1",
  siteId: "site_alpha",
  origin: ORIGIN,
  displayName: "Example Test",
  relayUrl: "http://relay.test:8787",
  deviceCredential: "ubd_test",
};

function storageWithSite(site) {
  const storage = makeStorage();
  storage.seed({ site: site || SITE });
  return storage;
}

function newTab(storage, url) {
  return openTab({ storage: storage, url: url || URL_UNDER_TEST });
}

test("a removed annotation does not come back after a reload", async () => {
  const storage = storageWithSite();
  const tab = newTab(storage);
  await tab.toggle();

  await tab.addAnnotation("h1", "Tjänster", "Change heading to Our Services");
  await tab.addAnnotation("h2", "Priser", "Change heading to Pricing");
  assert.deepEqual(tab.queueTexts(), ["Change heading to Our Services", "Change heading to Pricing"]);

  // Remove the first annotation with ×.
  await tab.deleteAt(0);
  assert.deepEqual(tab.queueTexts(), ["Change heading to Pricing"]);
  assert.equal(tab.markers().length, 1);

  // Reload: a brand-new content-script instance on the same page and store.
  const reloaded = newTab(storage);
  await reloaded.toggle();
  await reloaded.openPanel();

  assert.deepEqual(
    reloaded.queueTexts(),
    ["Change heading to Pricing"],
    "the removed annotation must not be restored from storage"
  );
  assert.equal(reloaded.markers().length, 1, "no stale marker may come back");
});

test("a late status in a second tab cannot resurrect a removed annotation", async () => {
  const storage = storageWithSite();
  const tabA = newTab(storage);
  await tabA.toggle();
  await tabA.addAnnotation("h1", "Tjänster", "Change heading to Our Services");
  await tabA.addAnnotation("h2", "Priser", "Change heading to Pricing");

  // Tab B was opened while both annotations existed and has them in memory.
  const tabB = newTab(storage);
  await tabB.toggle();
  assert.equal(tabB.markers().length, 2, "tab B should restore both annotations");
  // Materialise tab B's panel (it receives a status later, which needs it).
  tabB.select("p", "Footer");
  assert.deepEqual(tabB.queueTexts(), ["Change heading to Our Services", "Change heading to Pricing"]);

  // The user removes BOTH annotations in tab A.
  await tabA.deleteAt(1);
  await tabA.deleteAt(0);
  assert.deepEqual(tabA.queueTexts(), []);

  // Days-old round for tab B finally reports in (late status). This used to
  // persist tab B's whole stale queue, restoring what tab A had deleted.
  tabB.msg({
    type: "ubJobStatus",
    status: "done",
    jobId: "job_old",
    annotationResults: [
      { annotationId: "ann_x", status: "done", summary: "ok" },
    ],
  });
  await new Promise((r) => setTimeout(r, 20));

  const reloaded = newTab(storage);
  await reloaded.toggle();
  await reloaded.openPanel();
  assert.deepEqual(
    reloaded.queueTexts(),
    [],
    "a late status must never write back deleted annotations"
  );
});

test("a write on one page cannot resurrect a deletion on another page", async () => {
  const storage = storageWithSite();
  const tabB = newTab(storage, URL_OTHER_PAGE);
  await tabB.toggle();
  await tabB.addAnnotation("h2", "Priser", "Change the pricing heading");

  // Page A loads a snapshot of the whole queue map before page B's deletion.
  const tabA = newTab(storage, URL_UNDER_TEST);
  await tabA.toggle();
  await tabA.addAnnotation("h1", "Tjänster", "Change heading to Our Services");

  await tabB.deleteAt(0);
  assert.deepEqual(tabB.queueTexts(), []);

  // Page A keeps working; the old persist() re-wrote its whole stale map.
  await tabA.addAnnotation("h3", "Kontakt", "Change the contact heading");

  const reloadedB = newTab(storage, URL_OTHER_PAGE);
  await reloadedB.toggle();
  await reloadedB.openPanel();
  assert.deepEqual(reloadedB.queueTexts(), [], "page B's deletion must survive page A's writes");
});
