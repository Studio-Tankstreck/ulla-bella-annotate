// Ulla-Bella Extension — the ONE session writer (pure, injectable storage).
//
// Why this module exists: `session.mergeWrite()` is a read-merge-write, so two
// CONTEXTS doing it concurrently still lose updates (both read the same stored
// document, then both write; the later write wins and the earlier tombstone is
// gone). Serializing inside one tab (`writeTail` in content.js) only serializes
// that tab.
//
// The service worker therefore owns every write for every session key and runs
// them through ONE queue per key. Within one worker instance a key's mutations
// are strictly ordered, so no read-merge-write can interleave with another; and
// because the queue key is the storage key, different sessions never block each
// other.
//
// Service-worker restarts (MV3 kills the worker) are covered by three
// properties:
//   1. the queue holds no state that matters — everything lives in storage, so
//      a fresh worker simply has an empty queue;
//   2. a mutation is a single `set` (read → merge → set), so a kill either
//      happens before the set (nothing written, the caller retries — the merge
//      is idempotent) or after it (the write stands);
//   3. the caller keeps its own document and retries, and every retry re-reads
//      the current stored document, so a retry converges instead of
//      duplicating.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.UllaBellaSessionWriter = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // createWriter({ read, write, session })
  //   read(key)                  -> Promise<stored document | undefined>
  //   write(key, session, extra) -> Promise<void>   (extra = { migrate })
  //   session                    -> the session module (defaults to the global)
  function createWriter(opts) {
    const o = opts || {};
    if (typeof o.read !== "function" || typeof o.write !== "function") {
      throw new Error("session-writer: read and write are required");
    }
    const sessionMod =
      o.session || (typeof globalThis !== "undefined" ? globalThis.UllaBellaSession : null);
    if (!sessionMod) throw new Error("session-writer: session module is required");

    // key -> tail promise. A rejected tail must never wedge the queue, so the
    // stored tail is always a swallowing promise.
    const tails = new Map();

    async function applyOnce(key, local, extra) {
      const stored = await o.read(key);
      const merged = sessionMod.mergeWrite(stored, local);
      if (merged.write) {
        await o.write(key, merged.session, extra || null);
      }
      return {
        session: merged.session,
        write: merged.write,
        reason: merged.reason || (merged.write ? "merge" : "refused"),
      };
    }

    // submit serializes one mutation for one session key. Safe to call from any
    // context; safe to retry with the same document.
    function submit(key, local, extra) {
      if (!key) return Promise.reject(new Error("session-writer: key is required"));
      if (!local || typeof local !== "object") {
        return Promise.reject(new Error("session-writer: session document is required"));
      }
      const prev = tails.get(key) || Promise.resolve();
      const run = prev.then(
        function () {
          return applyOnce(key, local, extra);
        },
        function () {
          return applyOnce(key, local, extra);
        }
      );
      const tail = run.then(
        function () {},
        function () {}
      );
      tails.set(key, tail);
      tail.then(function () {
        // Keep the map bounded: only drop the entry if it is still ours.
        if (tails.get(key) === tail) tails.delete(key);
      });
      return run;
    }

    return {
      submit: submit,
      // pending() is for diagnostics/tests: how many keys have work queued.
      pending: function () {
        return tails.size;
      },
    };
  }

  return { createWriter: createWriter };
});
