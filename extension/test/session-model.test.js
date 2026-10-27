"use strict";

// Unit tests for the pure session model (src/session.js): identity, tombstones,
// merge-on-write, clear, legacy import. No DOM, no chrome.*.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const S = require(path.join(__dirname, "..", "src", "session.js"));

const SITE = "site_alpha";
const PAGE = "https://example.test/tjanster";

function ann(id, instruction, extra) {
  return Object.assign(
    { annotationId: id, instruction: instruction, target: { url: PAGE, elementType: "h1" } },
    extra || {}
  );
}

function base() {
  return S.normalize(null, { siteId: SITE, pageId: PAGE, siteName: "Example Test", pageUrl: PAGE });
}

function withAnns(list) {
  return S.withAnnotations(base(), list);
}

test("storageKey isolates by site and page", () => {
  const a = S.storageKey("site_a", PAGE);
  const b = S.storageKey("site_b", PAGE);
  const c = S.storageKey("site_a", PAGE + "?x=1");
  assert.notEqual(a, b, "two sites never share a key");
  assert.notEqual(a, c, "two pages of one site never share a key");
  assert.ok(a.startsWith(S.KEY_PREFIX));
  assert.equal(S.storageKey(null, PAGE), S.KEY_PREFIX + "site_unknown|" + PAGE);
});

test("normalize drops malformed annotations and anything already tombstoned", () => {
  const raw = {
    sessionId: "ses_1",
    annotations: [
      ann("ann_1", "keep"),
      { instruction: "no id" },
      { annotationId: "ann_2" },
      ann("ann_3", "tombstoned"),
      ann("ann_1", "duplicate id"),
    ],
    deleted: { ann_3: "2026-10-01T00:00:00.000Z" },
  };
  const s = S.normalize(raw, { siteId: SITE, pageId: PAGE });
  assert.deepEqual(
    s.annotations.map((a) => a.annotationId),
    ["ann_1"]
  );
  assert.equal(s.annotations[0].instruction, "keep");
  assert.equal(s.sessionId, "ses_1");
  assert.ok(s.deleted.ann_3);
});

test("removeAnnotation tombstones and drops the annotation", () => {
  const s = withAnns([ann("ann_1", "one"), ann("ann_2", "two")]);
  const removed = S.removeAnnotation(s, "ann_1");
  assert.deepEqual(
    removed.annotations.map((a) => a.annotationId),
    ["ann_2"]
  );
  assert.ok(removed.deleted.ann_1, "the removal is recorded");
  assert.ok(removed.rev > s.rev, "rev advances");
  // The tombstone is sticky: re-adding the same id is refused.
  const readded = S.withAnnotations(removed, removed.annotations.concat([ann("ann_1", "one")]));
  assert.deepEqual(
    readded.annotations.map((a) => a.annotationId),
    ["ann_2"]
  );
});

test("a stale writer cannot resurrect a tombstoned annotation in mergeWrite", () => {
  const live = withAnns([ann("ann_1", "one"), ann("ann_2", "two")]);
  const afterDelete = S.removeAnnotation(live, "ann_1");

  // A second tab still holds BOTH annotations and tries to persist them.
  const stale = live;
  const merged = S.mergeWrite(afterDelete, stale);
  assert.equal(merged.write, true);
  assert.deepEqual(
    merged.session.annotations.map((a) => a.annotationId),
    ["ann_2"],
    "the tombstone wins over the stale snapshot"
  );
  assert.ok(merged.session.deleted.ann_1);
});

test("mergeWrite keeps annotations the other side added", () => {
  const a = withAnns([ann("ann_1", "one")]);
  const b = withAnns([ann("ann_2", "two")]);
  const merged = S.mergeWrite(a, b);
  assert.deepEqual(
    merged.session.annotations.map((x) => x.annotationId).sort(),
    ["ann_1", "ann_2"]
  );
});

test("mergeWrite prefers the more recently edited copy of one annotation", () => {
  const older = withAnns([ann("ann_1", "old text", { updatedAt: "2026-10-01T00:00:00.000Z" })]);
  const newer = withAnns([ann("ann_1", "new text", { updatedAt: "2026-10-02T00:00:00.000Z" })]);
  assert.equal(S.mergeWrite(older, newer).session.annotations[0].instruction, "new text");
  assert.equal(S.mergeWrite(newer, older).session.annotations[0].instruction, "new text");
});

test("a tab holding a cleared session cannot write its old queue back", () => {
  const before = withAnns([ann("ann_1", "one"), ann("ann_2", "two")]);
  // Another tab clears the session; this tab still holds the pre-clear copy.
  const cleared = S.clear(before);
  const res = S.mergeWrite(cleared, before);
  assert.equal(res.write, false, "a stale tab must not write after a clear");
  assert.equal(res.session.sessionId, cleared.sessionId);
  assert.deepEqual(res.session.annotations, []);
});

test("the clearing tab is the successor of the session it cleared", () => {
  const before = withAnns([ann("ann_1", "one"), ann("ann_2", "two")]);
  const cleared = S.clear(before);
  const res = S.mergeWrite(before, cleared);
  assert.equal(res.write, true, "the clear must land");
  assert.equal(res.session.sessionId, cleared.sessionId);
  assert.equal(res.session.previousSessionId, before.sessionId);
  assert.deepEqual(res.session.annotations, []);
});

test("clear wipes annotations and description, and keeps an unfinished round honest", () => {
  const withJob = S.withJob(withAnns([ann("ann_1", "one")]), {
    jobId: "job_1",
    status: "working",
    siteId: SITE,
  });
  const s = S.withDescription(withJob, "Tighten the page");
  const cleared = S.clear(s);
  assert.deepEqual(cleared.annotations, []);
  assert.equal(cleared.description, "");
  assert.ok(cleared.clearedAt);
  assert.notEqual(cleared.sessionId, s.sessionId, "a cleared session gets a new identity");
  assert.equal(cleared.job.jobId, "job_1", "a running round is kept (never faked as cancelled)");
  assert.equal(cleared.job.status, "working");

  const finished = S.withJob(s, { jobId: "job_2", status: "done" });
  assert.equal(S.clear(finished).job, null, "a finished round is dropped");
});

test("fromLegacy preserves ids, instructions and results and marks the import", () => {
  const legacy = {
    annotations: [
      { annotationId: "ann_old_1", instruction: "old one", target: { url: PAGE }, result: { status: "done" } },
      { instruction: "no id" },
    ],
    job: { jobId: "job_old", status: "done" },
  };
  const s = S.fromLegacy(legacy, { siteId: SITE, pageId: PAGE, siteName: "Example Test" });
  assert.equal(s.annotations.length, 1);
  assert.equal(s.annotations[0].annotationId, "ann_old_1");
  assert.equal(s.annotations[0].result.status, "done");
  assert.equal(s.job.jobId, "job_old");
  assert.ok(s.legacy.migratedAt, "the import is recorded on the session");
  assert.ok(s.sessionId, "a migrated entry gets a stable session id");
});

test("reconcile adopts a newer write and ignores a stale one", () => {
  const local = withAnns([ann("ann_1", "one"), ann("ann_2", "two")]);
  const fromOther = S.removeAnnotation(S.withAnnotations(local, local.annotations), "ann_1");

  const adopted = S.reconcile(local, fromOther);
  assert.deepEqual(
    adopted.annotations.map((a) => a.annotationId),
    ["ann_2"],
    "the other tab's tombstone is adopted"
  );

  const stale = S.withAnnotations(local, [ann("ann_1", "one")]); // lower rev, older state
  const kept = S.reconcile(adopted, stale);
  assert.deepEqual(
    kept.annotations.map((a) => a.annotationId),
    ["ann_2"],
    "a stale snapshot never removes the tombstone"
  );
  assert.equal(kept.sessionId, adopted.sessionId);
});

test("reconcile replaces the document when the slot was cleared elsewhere", () => {
  const local = withAnns([ann("ann_1", "one")]);
  const cleared = S.clear(local);
  const next = S.reconcile(local, cleared);
  assert.equal(next.sessionId, cleared.sessionId);
  assert.deepEqual(next.annotations, []);
});

test("a newer job wins, and a terminal job beats a non-terminal one", () => {
  const running = S.withJob(base(), { jobId: "job_1", status: "working", submittedAt: "2026-10-01T00:00:00.000Z" });
  const newerRound = S.withJob(running, { jobId: "job_2", status: "sending", submittedAt: "2026-10-02T00:00:00.000Z" });
  assert.equal(S.mergeWrite(running, newerRound).session.job.jobId, "job_2");

  const finished = S.withJob(running, { jobId: "job_1", status: "done", submittedAt: "2026-10-01T00:00:00.000Z" });
  assert.equal(
    S.mergeWrite(finished, running).session.job.status,
    "done",
    "a late non-terminal snapshot cannot un-finish a round"
  );
});
