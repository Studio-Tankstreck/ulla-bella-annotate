"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const q = require("../src/queue.js");

// --- pageId ---------------------------------------------------------------

test("pageId: origin + pathname, ignores plain anchors and tracking params", () => {
  assert.equal(q.pageId("https://example.test/services"), "https://example.test/services");
  assert.equal(q.pageId("https://example.test/services#section-2"), "https://example.test/services");
  assert.equal(q.pageId("https://example.test/services?utm_campaign=x"), "https://example.test/services");
});

test("pageId: routing hash is a distinct page", () => {
  assert.equal(q.pageId("https://example.test/#/page/1"), "https://example.test/#/page/1");
  assert.equal(q.pageId("https://example.test/#!/page/2"), "https://example.test/#!/page/2");
  assert.notEqual(q.pageId("https://example.test/#/page/1"), q.pageId("https://example.test/#/page/2"));
});

test("pageId: content query params are distinct; tracking params stripped", () => {
  assert.equal(q.pageId("https://example.test/item?id=1"), "https://example.test/item?id=1");
  assert.notEqual(q.pageId("https://example.test/item?id=1"), q.pageId("https://example.test/item?id=2"));
  assert.equal(q.pageId("https://example.test/item?utm_source=x&fbclid=y"), "https://example.test/item");
  assert.equal(q.pageId("https://example.test/item?id=1&utm_source=x"), "https://example.test/item?id=1");
});

// --- queue ops ------------------------------------------------------------

test("addToQueue appends and caps at 8", () => {
  let queue = [];
  for (let i = 0; i < 8; i++) {
    const r = q.addToQueue(queue, { annotationId: "a" + i, instruction: "x", target: {} });
    assert.ok(r, "should append under cap");
    queue = r;
  }
  assert.equal(queue.length, 8);
  assert.equal(q.addToQueue(queue, { annotationId: "x" }), null, "9th must be rejected");
});

test("removeFromQueue removes by annotationId and renumbers positionally", () => {
  let queue = [
    { annotationId: "a", instruction: "1", target: {} },
    { annotationId: "b", instruction: "2", target: {} },
    { annotationId: "c", instruction: "3", target: {} },
  ];
  queue = q.removeFromQueue(queue, "b");
  assert.equal(queue.length, 2);
  assert.deepEqual(queue.map((x) => x.annotationId), ["a", "c"]);
});

test("updateInstruction keeps stable annotationId and position", () => {
  let queue = [
    { annotationId: "a", instruction: "one", target: {} },
    { annotationId: "b", instruction: "two", target: {} },
  ];
  queue = q.updateInstruction(queue, "a", "edited");
  assert.equal(queue[0].instruction, "edited");
  assert.equal(queue[0].annotationId, "a");
  assert.equal(queue[1].instruction, "two");
});

test("serialize strips live element references and keeps result", () => {
  const queue = [
    { annotationId: "a", instruction: "x", target: { url: "u" }, element: { some: "dom" }, result: { status: "done" } },
  ];
  const s = q.serialize(queue);
  assert.equal(s[0].element, undefined);
  assert.equal(s[0].annotationId, "a");
  assert.equal(s[0].target.url, "u");
  assert.equal(s[0].result.status, "done");
});

// --- results --------------------------------------------------------------

function base() {
  return [
    { annotationId: "a", instruction: "1", target: {} },
    { annotationId: "b", instruction: "2", target: {} },
    { annotationId: "c", instruction: "3", target: {} },
  ];
}

test("applyResults: all done", () => {
  const out = q.applyResults(base(), [
    { annotationId: "a", status: "done", summary: "ok" },
    { annotationId: "b", status: "done", summary: "ok" },
    { annotationId: "c", status: "done", summary: "ok" },
  ]);
  assert.ok(out.every((a) => a.result.status === "done"));
});

test("applyResults: partial success + missing becomes unknown", () => {
  const out = q.applyResults(base(), [
    { annotationId: "a", status: "done", summary: "ok" },
    { annotationId: "b", status: "error", error: { code: "edit_failed", message: "x" } },
  ]);
  assert.equal(out[0].result.status, "done");
  assert.equal(out[1].result.status, "error");
  assert.equal(out[1].result.error.code, "edit_failed");
  assert.equal(out[2].result.status, "unknown");
});

test("applyResults: unknown annotationId is ignored", () => {
  const out = q.applyResults(base(), [
    { annotationId: "zzz", status: "done", summary: "x" },
    { annotationId: "a", status: "done", summary: "ok" },
  ]);
  assert.equal(out[0].result.status, "done");
  assert.equal(out[1].result.status, "unknown");
  assert.equal(out[2].result.status, "unknown");
});

test("markProcessing and markUncertain", () => {
  assert.ok(q.markProcessing(base()).every((a) => a.result.status === "processing"));
  assert.ok(q.markUncertain(base()).every((a) => a.result.status === "unknown"));
});

test("applyResults: missing annotationResults (undefined) makes every result unknown", () => {
  const out = q.applyResults(base(), undefined);
  assert.deepEqual(out.map((a) => a.result.status), ["unknown", "unknown", "unknown"]);
});

test("applyResults: empty annotationResults makes every result unknown", () => {
  const out = q.applyResults(base(), []);
  assert.deepEqual(out.map((a) => a.result.status), ["unknown", "unknown", "unknown"]);
});
