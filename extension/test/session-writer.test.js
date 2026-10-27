"use strict";

// Unit tests for the single session writer: serialization per key, isolation
// between keys, survival of a failing write, and correctness across a
// "service worker restart" (a fresh writer instance with the same storage).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const S = require(path.join(__dirname, "..", "src", "session.js"));
const { createWriter } = require(path.join(__dirname, "..", "src", "session-writer.js"));

function tick(ms) {
  return new Promise((r) => setTimeout(r, ms || 0));
}

function fakeStore(initial) {
  let data = JSON.parse(JSON.stringify(initial || {}));
  const ops = [];
  const gates = new Map(); // key -> promise that must settle before a write lands
  return {
    data: () => JSON.parse(JSON.stringify(data)),
    ops: ops,
    gate: function (key, promise) {
      gates.set(key, promise);
    },
    read: async function (key) {
      await tick(1);
      return data[key] ? JSON.parse(JSON.stringify(data[key])) : undefined;
    },
    write: async function (key, value) {
      const gate = gates.get(key);
      if (gate) {
        gates.delete(key);
        await gate;
      }
      await tick(1);
      data[key] = JSON.parse(JSON.stringify(value));
      ops.push(key);
    },
  };
}

function ann(id, instruction) {
  return { annotationId: id, instruction: instruction, target: {} };
}

function sessionWith(list) {
  return S.withAnnotations(S.empty({ siteId: "s", pageId: "/p" }), list);
}

test("two submissions for one key are serialized, so a stale one cannot win", async () => {
  const key = "ub.session.s|/p";
  const original = sessionWith([ann("ann_old", "old"), ann("ann_keep", "keep")]);
  const store = fakeStore({ [key]: original });
  const writer = createWriter({ session: S, read: store.read, write: store.write });

  const deleteLocal = S.removeAnnotation(original, "ann_old");
  const staleLocal = sessionWith([ann("ann_old", "old"), ann("ann_keep", "keep")]);
  assert.equal(staleLocal.deleted.ann_old, undefined, "sanity: the stale input has no tombstone");

  // Both are in flight at the same time; the stale one is submitted second.
  const [a, b] = await Promise.all([
    writer.submit(key, deleteLocal),
    writer.submit(key, staleLocal),
  ]);

  assert.equal(a.write, true);
  assert.equal(b.session.deleted.ann_old === undefined, false, "the second answer carries the tombstone");
  const stored = store.data()[key];
  assert.ok(stored.deleted.ann_old, "the tombstone is stored");
  assert.deepEqual(
    stored.annotations.map((x) => x.annotationId),
    ["ann_keep"],
    "the stale submission was merged, not written over the deletion"
  );
});

test("a second writer instance (worker restart) still merges with the store", async () => {
  const key = "ub.session.s|/p";
  const original = sessionWith([ann("ann_old", "old")]);
  const store = fakeStore({ [key]: original });

  const first = createWriter({ session: S, read: store.read, write: store.write });
  await first.submit(key, S.removeAnnotation(original, "ann_old"));
  assert.ok(store.data()[key].deleted.ann_old);

  // The worker was restarted: no in-memory queue, state only in storage.
  const second = createWriter({ session: S, read: store.read, write: store.write });
  const outcome = await second.submit(key, original); // a pre-deletion document
  assert.equal(outcome.write, true);
  assert.ok(store.data()[key].deleted.ann_old, "the restart did not forget the deletion");
  assert.deepEqual(store.data()[key].annotations, []);
});

test("different session keys do not block each other", async () => {
  const keyA = "ub.session.s|/a";
  const keyB = "ub.session.s|/b";
  const store = fakeStore({});
  const writer = createWriter({ session: S, read: store.read, write: store.write });

  let releaseA;
  store.gate(keyA, new Promise((resolve) => (releaseA = resolve)));

  const aP = writer.submit(keyA, sessionWith([ann("ann_a1", "a")]));
  const bP = writer.submit(keyB, sessionWith([ann("ann_b1", "b")]));

  // B must complete while A is still gated.
  const b = await bP;
  assert.equal(b.write, true);
  assert.ok(store.data()[keyB], "the other session was written");
  assert.equal(store.data()[keyA], undefined, "the gated session is still waiting");

  releaseA();
  await aP;
  assert.ok(store.data()[keyA]);
});

test("a failing write does not wedge the queue", async () => {
  const key = "ub.session.s|/p";
  const store = fakeStore({});
  let fail = true;
  const writer = createWriter({
    session: S,
    read: store.read,
    write: async function (k, v) {
      if (fail) {
        fail = false;
        throw new Error("disk on fire");
      }
      return store.write(k, v);
    },
  });

  await assert.rejects(writer.submit(key, sessionWith([ann("ann_1", "one")])));
  const ok = await writer.submit(key, sessionWith([ann("ann_2", "two")]));
  assert.equal(ok.write, true);
  assert.deepEqual(
    store.data()[key].annotations.map((a) => a.annotationId),
    ["ann_2"]
  );
});

test("submit rejects without a key or a session document", async () => {
  const writer = createWriter({
    session: S,
    read: async function () {},
    write: async function () {},
  });
  await assert.rejects(writer.submit("", sessionWith([])));
  await assert.rejects(writer.submit("k", null));
});
