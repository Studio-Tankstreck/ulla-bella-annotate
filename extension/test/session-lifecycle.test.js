"use strict";

// Session-lifecycle regression suite (Task: sessions etapp 1).
//
// Every test drives the REAL content script against a shared asynchronous
// chrome.storage.local. Covered behaviour:
//   - a removal survives reload, a late status and a second tab,
//   - two tabs converge without a reload,
//   - "Clear session" is scoped to one session (site + page) and names it,
//   - deleting/clearing while a round is running never claims to cancel it,
//   - two connected sites never share a queue,
//   - the pre-2.2 `queues` state is migrated once and stays deletable,
//   - annotationId ↔ result matching survives a deletion mid-round.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { makeStorage, openTab } = require("./support/tab");
const sessionMod = require(path.join(__dirname, "..", "src", "session.js"));

const ORIGIN = "https://example.test";
const URL_UNDER_TEST = ORIGIN + "/tjanster";
const URL_OTHER_PAGE = ORIGIN + "/priser";

function site(overrides) {
  return Object.assign(
    {
      deviceId: "dev_1",
      siteId: "site_alpha",
      origin: ORIGIN,
      displayName: "Example Test",
      relayUrl: "http://relay.test:8787",
      deviceCredential: "ubd_test",
    },
    overrides || {}
  );
}

function storageWithSite(s) {
  const storage = makeStorage();
  storage.seed({ site: s || site() });
  return storage;
}

function newTab(storage, url) {
  return openTab({ storage: storage, url: url || URL_UNDER_TEST });
}

async function seedTwoAnnotations(tab) {
  await tab.addAnnotation("h1", "Tjänster", "Change heading to Our Services");
  await tab.addAnnotation("h2", "Priser", "Change heading to Pricing");
}

function annotationIds(job) {
  return job.annotations.map((a) => a.annotationId);
}

// --- cross-tab convergence ---------------------------------------------------

test("a removal in one tab disappears in the other tab without a reload", async () => {
  const storage = storageWithSite();
  const tabA = newTab(storage);
  await tabA.toggle();
  await seedTwoAnnotations(tabA);

  const tabB = newTab(storage);
  await tabB.toggle();
  await tabB.openPanel();
  assert.equal(tabB.queueTexts().length, 2);

  await tabA.deleteAt(0);

  assert.deepEqual(
    tabB.queueTexts(),
    ["Change heading to Pricing"],
    "the other tab must adopt the tombstone"
  );
  assert.equal(tabB.markers().length, 1);
});

// --- Clear session -----------------------------------------------------------

test("Clear session clears only its own session and names it", async () => {
  const storage = storageWithSite();
  const otherTab = newTab(storage, URL_OTHER_PAGE);
  await otherTab.toggle();
  await otherTab.addAnnotation("h2", "Priser", "Change the pricing heading");

  const tab = newTab(storage);
  await tab.toggle();
  await seedTwoAnnotations(tab);

  // A session description (the field the etapp-2 flow will collect).
  const key = sessionMod.storageKey("http://relay.test:8787|site_alpha", pageId(URL_UNDER_TEST));
  storage.seed(
    Object.assign({}, storage.raw(), {
      site: site(),
      [key]: Object.assign({}, storage.raw()[key], { description: "Tighten the services page" }),
    })
  );

  const reloaded = newTab(storage);
  await reloaded.toggle();
  await reloaded.openPanel();
  assert.equal(reloaded.queueTexts().length, 2);

  assert.match(reloaded.sessionLabel(), /Example Test/);
  assert.match(reloaded.sessionLabel(), /\/tjanster/);

  // First click arms, second click clears.
  const btn = reloaded.panelPart(".ullabella-clear");
  btn.dispatch("click", {});
  await new Promise((r) => setTimeout(r, 10));
  assert.match(reloaded.statusText(), /Click again to clear this session: Example Test · \/tjanster/);
  btn.dispatch("click", {});
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(reloaded.queueTexts(), []);
  assert.equal(reloaded.markers().length, 0);
  assert.match(reloaded.statusText(), /Session cleared/);

  const stored = storage.raw();
  const cleared = stored[key];
  assert.equal(cleared.annotations.length, 0, "annotations cleared from storage");
  assert.equal(cleared.description, "", "the session description is cleared too");
  assert.ok(cleared.clearedAt, "the clear is recorded");
  assert.ok(stored.site, "connection settings are preserved");

  const otherKey = sessionMod.storageKey("http://relay.test:8787|site_alpha", pageId(URL_OTHER_PAGE));
  assert.equal(stored[otherKey].annotations.length, 1, "another page's session is untouched");

  // And it stays cleared after a reload.
  const again = newTab(storage);
  await again.toggle();
  await again.openPanel();
  assert.deepEqual(again.queueTexts(), []);
});

// --- running rounds ----------------------------------------------------------

test("removing an annotation while a round runs says the round keeps running", async () => {
  const storage = storageWithSite();
  const tab = newTab(storage);
  await tab.toggle();
  await seedTwoAnnotations(tab);
  await tab.send();
  tab.answerSend({ ok: true });

  await tab.deleteAt(0);

  assert.match(tab.statusText(), /does not cancel it/);
  const job = tab.lastJob();
  assertEquals(annotationIds(job).length, 2, "the submitted round is unchanged");
});

test("a late result after Clear session is discarded, not rendered", async () => {
  const storage = storageWithSite();
  const tab = newTab(storage);
  await tab.toggle();
  await seedTwoAnnotations(tab);
  await tab.send();
  const job = tab.lastJob();
  tab.answerSend({ ok: true });

  await tab.clearSession();
  assert.deepEqual(tab.queueTexts(), []);
  assert.match(tab.statusText(), /keeps running/);

  // The round finishes in the background and its result arrives late.
  tab.msg({
    type: "ubJobStatus",
    status: "done",
    jobId: job.jobId,
    annotationResults: annotationIds(job).map((id) => ({ annotationId: id, status: "done", summary: "ok" })),
  });
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(tab.queueTexts(), [], "cleared annotations must not come back");
  assert.equal(tab.markers().length, 0);

  const reloaded = newTab(storage);
  await reloaded.toggle();
  await reloaded.openPanel();
  assert.deepEqual(reloaded.queueTexts(), []);
});

test("a status for another round id is ignored", async () => {
  const storage = storageWithSite();
  const tab = newTab(storage);
  await tab.toggle();
  await seedTwoAnnotations(tab);
  await tab.send();
  tab.answerSend({ ok: true });

  tab.msg({
    type: "ubJobStatus",
    status: "done",
    jobId: "job_someone_else",
    annotationResults: [{ annotationId: "ann_other", status: "done", summary: "ok" }],
  });
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(!tab.statusText().includes("completed"), "a foreign jobId must not settle this session");
});

// --- isolation ---------------------------------------------------------------

test("two connected sites never share a queue, even on the same path", async () => {
  const storage = makeStorage();
  storage.seed({ site: site({ siteId: "site_alpha", displayName: "Alpha" }) });
  const alpha = newTab(storage);
  await alpha.toggle();
  await alpha.addAnnotation("h1", "Tjänster", "Alpha: change the heading");

  // Re-pair this browser to another site (same origin/path).
  storage.seed(
    Object.assign({}, storage.raw(), {
      site: site({ siteId: "site_beta", displayName: "Beta" }),
    })
  );
  const beta = newTab(storage);
  await beta.toggle();
  await beta.openPanel();
  assert.deepEqual(beta.queueTexts(), [], "another site must start empty");
  assert.match(beta.sessionLabel(), /Beta/);

  await beta.addAnnotation("h2", "Priser", "Beta: change the pricing heading");

  // The Alpha tab keeps its own queue, and the two sites' documents are
  // separate keys — nothing is shared even though the path is identical.
  assert.deepEqual(alpha.queueTexts(), ["Alpha: change the heading"]);

  const stored = storage.raw();
  const alphaKey = sessionMod.storageKey("http://relay.test:8787|site_alpha", pageId(URL_UNDER_TEST));
  const betaKey = sessionMod.storageKey("http://relay.test:8787|site_beta", pageId(URL_UNDER_TEST));
  assert.deepEqual(
    stored[alphaKey].annotations.map((a) => a.instruction),
    ["Alpha: change the heading"]
  );
  assert.deepEqual(
    stored[betaKey].annotations.map((a) => a.instruction),
    ["Beta: change the pricing heading"]
  );
});

// --- migration of the pre-2.2 state -----------------------------------------

test("a pre-2.2 queues entry is migrated once and stays deletable", async () => {
  const storage = makeStorage();
  storage.seed({
    site: site(),
    queues: {
      [pageId(URL_UNDER_TEST)]: {
        annotations: [
          {
            annotationId: "ann_legacy_1",
            instruction: "Old: change the heading",
            target: { url: URL_UNDER_TEST, elementType: "h1", visibleText: "Tjänster", selector: "h1" },
            result: { status: "done", summary: "ok" },
          },
          {
            annotationId: "ann_legacy_2",
            instruction: "Old: change the subheading",
            target: { url: URL_UNDER_TEST, elementType: "h2", visibleText: "Priser", selector: "h2" },
          },
        ],
        job: { jobId: "job_legacy", status: "done" },
      },
    },
  });

  const tab = newTab(storage);
  await tab.toggle();
  await tab.openPanel();
  assert.deepEqual(tab.queueTexts(), ["Old: change the heading", "Old: change the subheading"]);

  const key = sessionMod.storageKey("http://relay.test:8787|site_alpha", pageId(URL_UNDER_TEST));
  const migrated = storage.raw()[key];
  assert.ok(migrated, "legacy entry migrated into a session");
  assert.equal(migrated.annotations[0].annotationId, "ann_legacy_1", "ids are preserved (result matching)");
  assert.equal(migrated.job.jobId, "job_legacy");
  assert.ok(storage.raw()[sessionMod.MIGRATED_KEY][key], "migration is marked");
  assert.ok(storage.raw()[sessionMod.LEGACY_KEY], "legacy data is kept, not destroyed");

  await tab.deleteAt(0);
  assert.deepEqual(tab.queueTexts(), ["Old: change the subheading"]);

  const reloaded = newTab(storage);
  await reloaded.toggle();
  await reloaded.openPanel();
  assert.deepEqual(
    reloaded.queueTexts(),
    ["Old: change the subheading"],
    "the legacy import must not re-add a deleted annotation"
  );
});

// --- annotationId ↔ result matching -----------------------------------------

test("per-annotation results still match after an annotation is removed mid-round", async () => {
  const storage = storageWithSite();
  const tab = newTab(storage);
  await tab.toggle();
  await tab.addAnnotation("h1", "Ett", "Change one");
  await tab.addAnnotation("h2", "Två", "Change two");
  await tab.addAnnotation("h3", "Tre", "Change three");
  await tab.send();
  const job = tab.lastJob();
  tab.answerSend({ ok: true });

  // Remove the middle annotation while the round runs.
  await tab.deleteAt(1);

  tab.msg({
    type: "ubJobStatus",
    status: "done",
    jobId: job.jobId,
    annotationResults: annotationIds(job).map((id) => ({ annotationId: id, status: "done", summary: "ok" })),
  });
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(tab.queueTexts(), ["Change one", "Change three"]);
  assert.deepEqual(tab.itemResultLabels(), ["\u2713", "\u2713"], "each remaining annotation keeps its own result");
  assert.equal(tab.statusText(), "2 of 2 completed successfully");
});

// --- helpers -----------------------------------------------------------------

function pageId(url) {
  return require(path.join(__dirname, "..", "src", "queue.js")).pageId(url);
}

function assertEquals(actual, expected, message) {
  assert.equal(actual, expected, message);
}
