"use strict";

// Etapp 2 regression suite: the session-description first step, the description
// in the panel, the job-wide context, the marker comment popover, and the save
// status the user can act on.
//
// Everything drives the REAL content script against one shared, asynchronous
// chrome.storage.local and the real session writer, exactly like the etapp 1
// suites.

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
    const doc = Object.assign(S.withAnnotations(base, annotations || []), extra || {});
    storage.seed({ site: SITE, [KEY]: doc });
  }
  const worker = makeWorker(storage);
  return {
    storage: storage,
    worker: worker,
    tab: function (opts) {
      return openTab(Object.assign({ storage: storage, worker: worker, url: URL_UNDER_TEST }, opts || {}));
    },
  };
}

// --- 1. the first step ------------------------------------------------------

test("a new session is offered the session description first", async () => {
  const s = setup();
  const tab = s.tab();
  await tab.toggle();

  assert.equal(tab.hasIntro(), true, "the first step must be offered");
  assert.equal(tab.introText(".ullabella-intro-title"), "Session description");
  assert.equal(tab.introText(".ullabella-intro-question"), "What do you want to do this time?");
  assert.equal(
    tab.introText(".ullabella-intro-help"),
    "Describe the purpose and anything that applies to every change. Then mark the details on the page."
  );
  // Accessible dialog wiring.
  const card = tab.intro().querySelector(".ullabella-intro-card");
  assert.equal(card.attrs.role, "dialog");
  assert.equal(card.attrs["aria-labelledby"], "ullabella-intro-title");

  // Nothing is stored until the user answers.
  assert.equal(storedSession(s.storage), undefined);
});

test("Start annotating saves the description and records the step", async () => {
  const s = setup();
  const tab = s.tab();
  await tab.toggle();
  tab.writeIntro("Rework the services page for the autumn campaign.");
  await tab.startAnnotating();

  assert.equal(tab.hasIntro(), false, "the step closes");
  const stored = storedSession(s.storage);
  assert.equal(stored.description, "Rework the services page for the autumn campaign.");
  assert.equal(stored.intro, "completed");
  assert.ok(stored.introAt);

  // The panel is open with the description readable.
  await tab.openPanel();
  assert.equal(tab.descriptionText(), "Rework the services page for the autumn campaign.");

  // Re-entering does not ask again.
  const again = s.tab();
  await again.toggle();
  assert.equal(again.hasIntro(), false, "a completed step must not come back");
});

test("Skip records the step, so an empty description is not asked again", async () => {
  const s = setup();
  const tab = s.tab();
  await tab.toggle();
  await tab.skipIntro();

  assert.equal(tab.hasIntro(), false);
  const stored = storedSession(s.storage);
  assert.equal(stored.description, "");
  assert.equal(stored.intro, "skipped", "a skip is an explicit decision");

  const again = s.tab();
  await again.toggle();
  assert.equal(again.hasIntro(), false, "an empty description must not re-open the question");
  await again.openPanel();
  assert.equal(again.descriptionText(), "No session description yet.");
});

test("Skip keeps whatever the user already typed", async () => {
  const s = setup();
  const tab = s.tab();
  await tab.toggle();
  tab.writeIntro("Typed but then skipped");
  await tab.skipIntro();

  const stored = storedSession(s.storage);
  assert.equal(stored.intro, "skipped");
  assert.equal(stored.description, "Typed but then skipped", "typing is never thrown away silently");
});

test("an existing session with annotations continues without the step", async () => {
  const s = setup([ann("ann_old", "Existing change")]);
  const tab = s.tab();
  await tab.toggle();

  assert.equal(tab.hasIntro(), false, "an existing session must not be blocked");
  const stored = storedSession(s.storage);
  assert.equal(stored.intro, "existing", "the step is recorded as already handled");
  assert.equal(stored.annotations.length, 1);
});

test("starting to annotate without answering records a skip", async () => {
  const s = setup();
  const tab = s.tab();
  await tab.toggle();
  await tab.addAnnotation("h1", "Tjänster", "Change the heading");

  assert.equal(tab.hasIntro(), false);
  assert.equal(storedSession(s.storage).intro, "skipped");
  assert.equal(storedSession(s.storage).annotations.length, 1);
});

test("Clear session resets the first step", async () => {
  const s = setup();
  const tab = s.tab();
  await tab.toggle();
  tab.writeIntro("A purpose");
  await tab.startAnnotating();
  await tab.addAnnotation("h1", "Tjänster", "Change the heading");
  await tab.clearSession();

  const stored = storedSession(s.storage);
  assert.equal(stored.intro, null, "a cleared session starts the step again");
  assert.equal(stored.description, "");

  const again = s.tab();
  await again.toggle();
  assert.equal(again.hasIntro(), true, "the next round starts with the question");
});

// --- 1b. the description in the panel --------------------------------------

test("the description can be read and edited from the panel", async () => {
  const s = setup([ann("ann_1", "Change the heading")], { intro: "skipped" });
  const tab = s.tab();
  await tab.toggle();
  await tab.openPanel();
  assert.equal(tab.descriptionText(), "No session description yet.");

  await tab.editDescription("Tighten the copy and keep it short.");
  assert.equal(tab.descriptionText(), "Tighten the copy and keep it short.");
  assert.equal(storedSession(s.storage).description, "Tighten the copy and keep it short.");

  await tab.editDescription("Second version");
  assert.equal(storedSession(s.storage).description, "Second version");

  const reloaded = s.tab();
  await reloaded.toggle();
  await reloaded.openPanel();
  assert.equal(reloaded.descriptionText(), "Second version", "the description survives a reload");
});

test("descriptions are isolated between sessions and sites", async () => {
  const storage = makeStorage();
  storage.seed({ site: SITE });
  const worker = makeWorker(storage);

  const a = openTab({ storage: storage, worker: worker, url: URL_UNDER_TEST });
  await a.toggle();
  a.writeIntro("Alpha page description");
  await a.startAnnotating();

  // Another page of the same site is a different session: its own step, its own
  // description.
  const otherPage = openTab({ storage: storage, worker: worker, url: ORIGIN + "/priser" });
  await otherPage.toggle();
  assert.equal(otherPage.hasIntro(), true, "another page has its own session");
  otherPage.writeIntro("Other page description");
  await otherPage.startAnnotating();

  // Re-pairing the browser to another site must never surface this description.
  storage.seed(
    Object.assign({}, storage.raw(), {
      site: Object.assign({}, SITE, { siteId: "site_beta", displayName: "Beta" }),
    })
  );
  const otherSite = openTab({ storage: storage, worker: worker, url: URL_UNDER_TEST });
  await otherSite.toggle();
  assert.equal(otherSite.hasIntro(), true, "another site starts a fresh session");
  await otherSite.skipIntro();
  await otherSite.openPanel();
  assert.equal(otherSite.descriptionText(), "No session description yet.");

  // The original session is untouched.
  assert.equal(storedSession(storage).description, "Alpha page description");
  const alphaKey = S.storageKey("http://relay.test:8787|site_alpha", pageId(ORIGIN + "/priser"));
  assert.equal(storage.raw()[alphaKey].description, "Other page description");
});

// --- 2. the job-wide context ----------------------------------------------

test("the submitted job carries the session description as job-wide context", async () => {
  const s = setup([ann("ann_1", "Change the heading"), ann("ann_2", "Change the subheading")], {
    intro: "completed",
    description: "Autumn campaign copy, short and factual.",
  });
  const tab = s.tab();
  await tab.toggle();
  await tab.openPanel();
  await tab.send();

  const job = tab.lastJob();
  assert.ok(job, "a job was submitted");
  assert.deepEqual(job.context, { session: "Autumn campaign copy, short and factual." });
  assert.equal(job.annotations.length, 2);
  // The description is context, not an extra annotation and not repeated per
  // annotation.
  for (const a of job.annotations) {
    assert.ok(!(a.context && a.context.session), "the description must not be duplicated per annotation");
  }
  assert.ok(
    !job.annotations.some((a) => a.instruction === "Autumn campaign copy, short and factual."),
    "the description must not become an annotation"
  );
});

test("a later description edit does not change an already submitted job", async () => {
  const s = setup([ann("ann_1", "Change the heading")], {
    intro: "completed",
    description: "First description",
  });
  const tab = s.tab();
  await tab.toggle();
  await tab.openPanel();
  await tab.send();
  const sent = tab.lastJob();
  assert.equal(sent.context.session, "First description");

  await tab.editDescription("Second description");
  const stored = storedSession(s.storage);
  assert.equal(stored.description, "Second description", "the session holds the new description");
  assert.equal(stored.job.sessionDescription, "First description", "the submitted round keeps its own");
  assert.equal(sent.context.session, "First description", "the sent payload is untouched");
});

test("a session without a description submits the old payload shape", async () => {
  const s = setup([ann("ann_1", "Change the heading")], { intro: "skipped" });
  const tab = s.tab();
  await tab.toggle();
  await tab.openPanel();
  await tab.send();

  const job = tab.lastJob();
  assert.equal(job.context, undefined, "no description means no context field at all");
  assert.equal(job.annotations.length, 1);
});

test("an older session stored before etapp 2 still works", async () => {
  // No intro, no description, no lineage fields — a pre-etapp-2 document.
  const storage = makeStorage();
  const oldKey = KEY;
  storage.seed({
    site: SITE,
    [oldKey]: {
      version: 2,
      sessionId: "ses_legacy",
      siteId: SITE.siteId,
      pageId: pageId(URL_UNDER_TEST),
      annotations: [ann("ann_legacy", "Old annotation")],
      deleted: {},
      rev: 3,
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
    },
  });
  const worker = makeWorker(storage);
  const tab = openTab({ storage: storage, worker: worker, url: URL_UNDER_TEST });
  await tab.toggle();
  await tab.openPanel();

  assert.deepEqual(tab.queueTexts(), ["Old annotation"], "the old queue is intact");
  assert.equal(tab.hasIntro(), false, "an old session is not blocked by the new step");

  await tab.send();
  const job = tab.lastJob();
  assert.equal(job.context, undefined, "an old session without a description sends no context");
  assert.equal(job.annotations[0].annotationId, "ann_legacy");
});

// --- 3. the marker comment popover ----------------------------------------

test("clicking a marker shows its full instruction in a comment", async () => {
  const s = setup([ann("ann_1", "Change the heading to Our Services"), ann("ann_2", "Change the subheading")], {
    intro: "skipped",
  });
  const tab = s.tab();
  await tab.toggle();
  await tab.openPanel();

  await tab.clickMarker(0);
  const parts = tab.commentParts();
  assert.ok(parts, "a comment is open");
  assert.equal(parts.title, "Annotation 1");
  assert.equal(parts.body, "Change the heading to Our Services");
  assert.equal(parts.role, "dialog");
  assert.equal(parts.label, "Annotation 1 comment");

  // Only one at a time; clicking another marker shows its comment.
  await tab.clickMarker(1);
  assert.equal(tab.commentParts().title, "Annotation 2");
  assert.equal(tab.commentParts().body, "Change the subheading");
  const all = tab.doc.documentElement.children.filter(
    (c) => c.classList && c.classList.contains("ullabella-comment")
  );
  assert.equal(all.length, 1, "exactly one comment is open");
});

test("a marker click does not also select a page element", async () => {
  const s = setup([ann("ann_1", "Change the heading")], { intro: "skipped" });
  const tab = s.tab();
  await tab.toggle();
  await tab.openPanel();
  const before = tab.panelPart(".ullabella-summary").textContent;

  await tab.clickMarker(0);
  assert.equal(tab.panelPart(".ullabella-summary").textContent, before, "no new selection was opened");
  assert.equal(tab.hasComment(), true);
});

test("the comment closes with the close button, Escape and an outside click", async () => {
  const s = setup([ann("ann_1", "Change the heading")], { intro: "skipped" });
  const tab = s.tab();
  await tab.toggle();
  await tab.openPanel();

  await tab.clickMarker(0);
  await tab.closeCommentViaX();
  assert.equal(tab.hasComment(), false, "closed by the close button");

  await tab.clickMarker(0);
  await tab.pressEscape();
  assert.equal(tab.hasComment(), false, "closed by Escape");
  // Escape must close the comment, not annotation mode: the markers survive.
  assert.equal(tab.markers().length, 1, "annotation mode is still active");

  await tab.clickMarker(0);
  const outside = tab.pageEl("p", "Somewhere else");
  tab.clickPage(outside);
  await settle(s.storage);
  assert.equal(tab.hasComment(), false, "closed by a click outside");
});

test("markers are keyboard reachable and open with Enter or Space", async () => {
  const s = setup([ann("ann_1", "Change the heading")], { intro: "skipped" });
  const tab = s.tab();
  await tab.toggle();

  const attrs = tab.markerAttrs(0);
  assert.equal(attrs.role, "button");
  assert.equal(attrs.tabindex, "0");
  assert.match(attrs.label, /^Annotation 1:/);
  assert.equal(attrs.expanded, "false");

  await tab.pressMarker(0, "Enter");
  assert.equal(tab.hasComment(), true, "Enter opens the comment");
  assert.equal(tab.markerAttrs(0).expanded, "true", "the marker reports the open state");

  await tab.pressEscape();
  assert.equal(tab.markerAttrs(0).expanded, "false");

  await tab.pressMarker(0, " ");
  assert.equal(tab.hasComment(), true, "Space opens the comment");
});

test("long instructions are complete text and user text is never HTML", async () => {
  const html = "<img src=x onerror=alert(1)> & a very long line ".repeat(40);
  const s = setup([ann("ann_1", html)], { intro: "skipped" });
  const tab = s.tab();
  await tab.toggle();
  await tab.clickMarker(0);

  const body = tab.comment().querySelector(".ullabella-comment-body");
  assert.equal(body.textContent, html, "the full instruction is shown, unmangled");
  assert.equal((body.children || []).length, 0, "no HTML was created from user text");
  assert.ok(
    body.classList.contains("ullabella-comment-body"),
    "the body carries the class whose CSS bounds its height and scrolls"
  );
});

test("removing or clearing the session closes the affected comment", async () => {
  const s = setup([ann("ann_1", "First"), ann("ann_2", "Second")], { intro: "skipped" });
  const tab = s.tab();
  await tab.toggle();
  await tab.openPanel();

  await tab.clickMarker(0);
  assert.equal(tab.hasComment(), true);
  await tab.deleteAt(0);
  assert.equal(tab.hasComment(), false, "deleting the annotation closes its comment");

  await tab.clickMarker(0);
  assert.equal(tab.hasComment(), true);
  await tab.clearSession();
  assert.equal(tab.hasComment(), false, "clearing the session closes the comment");
});

// --- 3b. the comment stays inside the viewport ----------------------------

test("the comment stays inside the viewport near the right and bottom edges", async () => {
  const s = setup([ann("ann_1", "Change the heading")], { intro: "skipped" });
  const tab = s.tab({ viewport: { width: 320, height: 240 } });
  await tab.toggle();

  tab.placeMarker(0, { left: 300, top: 220, width: 20, height: 20 });
  await tab.clickMarker(0);

  const style = tab.commentParts().style;
  const left = parseInt(style.left, 10);
  const top = parseInt(style.top, 10);
  // The fake comment box is 100x30 and the viewport 320x240, pad 8.
  assert.ok(left <= 320 - 8 - 100, "the comment is pulled in from the right edge");
  assert.ok(left >= 8, "the comment is inside the left edge");
  assert.ok(top >= 8, "the comment is inside the top edge");
  assert.ok(top + 30 <= 240 - 8, "the comment is flipped above the marker instead of overflowing");
});

// --- 4. save status --------------------------------------------------------

test("an unacknowledged change is shown as not saved and can be retried", async () => {
  const s = setup([ann("ann_1", "Existing")], { intro: "skipped" });
  const tab = s.tab();
  await tab.toggle();
  await tab.openPanel();

  // The worker cannot answer for the next few messages (killed mid-message):
  // exactly the three attempts of the add below.
  s.worker.goUnresponsive(3);
  await tab.addAnnotation("h2", "Priser", "A change that cannot be saved yet");
  await new Promise((r) => setTimeout(r, 300));
  await settle(s.storage);

  const bar = tab.savebar();
  assert.ok(bar, "a save bar exists");
  assert.equal(bar.hidden, false, "the unsaved state is visible");
  assert.match(bar.text, /not saved/i);
  assert.equal(bar.retryHidden, false, "Retry is offered");
  assert.equal(tab.queueTexts().length, 2, "the annotation is still there locally");

  await tab.retrySave();
  // The retry is delayed (40/80 ms), so wait past it before reading the store.
  await new Promise((r) => setTimeout(r, 350));
  await settle(s.storage);
  assert.equal(tab.savebar().hidden, true, "the bar clears once the write lands");
  assert.deepEqual(
    storedSession(s.storage).annotations.map((a) => a.instruction).sort(),
    ["A change that cannot be saved yet", "Existing"]
  );
});

test("a write refused after a clear elsewhere explains itself and never auto-restores", async () => {
  const s = setup([ann("ann_1", "Existing change")], { intro: "skipped" });
  // A tab that never sees storage events: it stays at the generation it loaded.
  const stale = openTab({
    storage: s.storage,
    worker: s.worker,
    url: URL_UNDER_TEST,
    silentOnChanged: true,
  });
  await stale.toggle();
  await stale.openPanel();
  await stale.addAnnotation("h2", "Priser", "Stale tab work");

  const other = s.tab();
  await other.toggle();
  await other.openPanel();
  await other.clearSession();
  assert.deepEqual(storedSession(s.storage).annotations, [], "the session is cleared");

  // The stale tab tries to write its two annotations into the cleared session.
  await stale.addAnnotation("h3", "Kontakt", "More stale work");
  await settle(s.storage);

  assert.deepEqual(
    storedSession(s.storage).annotations,
    [],
    "nothing was restored automatically"
  );

  const bar = stale.savebar();
  assert.ok(bar, "a save bar exists");
  assert.equal(bar.hidden, false, "the refusal is visible");
  assert.match(bar.text, /cleared in another tab/i);
  assert.match(bar.text, /not saved/i);
  assert.equal(bar.readdHidden, false, "the user can add their work back explicitly");
  assert.ok(
    bar.items.includes("More stale work"),
    "the user's text is still readable (and selectable for copying)"
  );

  // The explicit user action puts them into the CURRENT session.
  await stale.readdLost();
  const after = storedSession(s.storage);
  assert.deepEqual(
    after.annotations.map((a) => a.instruction).sort(),
    ["Existing change", "More stale work", "Stale tab work"].sort(),
    "the user's annotations come back — because the user asked for it"
  );
  assert.equal(stale.savebar().hidden, true, "the bar clears after the explicit action");
});
