// Ulla-Bella Extension — queue helpers (pure, no DOM).
//
// A queue is an array of { annotationId, instruction, target, element, result }
// where element is a live DOM node (never serialized) and result is an optional
// per-annotation outcome ({ status: "processing"|"done"|"error"|"unknown", ... }).
// All functions are pure and operate on the serializable subset so the queue can
// be unit-tested and persisted to chrome.storage.local without DOM references.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.UllaBellaQueue = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // MAX is the hard cap: one round holds at most eight annotations.
  const MAX = 8;

  // TRACKING matches known analytics/tracking query params that don't change
  // page content; they are stripped from the page identity.
  const TRACKING = /^(utm_|fbclid|gclid|mc_cid|mc_eid|_ga$|_gl$)/;

  // pageId returns a stable per-page identity:
  //   - origin + pathname: the core identity.
  //   - a routing hash (#/... or #!/...): a distinct SPA view.
  //   - the query string, minus known tracking params: query-routed pages.
  // Plain section anchors (#section) and tracking params do NOT split a round.
  function pageId(url) {
    try {
      const u = new URL(url);
      let id = u.origin + u.pathname;
      if (/^#!?\//.test(u.hash)) id += u.hash;
      const q = cleanSearch(u.search);
      if (q) id += "?" + q;
      return id;
    } catch (_) {
      return "";
    }
  }

  function cleanSearch(search) {
    if (!search) return "";
    const params = new URLSearchParams(search);
    for (const k of Array.from(params.keys())) {
      if (TRACKING.test(k)) params.delete(k);
    }
    return params.toString();
  }

  // serialize strips the live element, keeping only the serializable fields
  // (including any per-annotation result).
  function serialize(queue) {
    return (queue || []).map(function (a) {
      const o = { annotationId: a.annotationId, instruction: a.instruction, target: a.target };
      if (a.result) o.result = a.result;
      return o;
    });
  }

  // addToQueue appends an annotation, or returns null when the queue is full.
  function addToQueue(queue, annotation) {
    if (queue.length >= MAX) return null;
    return queue.concat([annotation]);
  }

  // removeFromQueue returns a new queue without the given annotationId. Marker
  // numbers are positional (index + 1), so removal implicitly renumbers.
  function removeFromQueue(queue, annotationId) {
    return queue.filter(function (a) {
      return a.annotationId !== annotationId;
    });
  }

  // updateInstruction replaces the instruction of one annotation, preserving its
  // stable annotationId and position.
  function updateInstruction(queue, annotationId, instruction) {
    return queue.map(function (a) {
      return a.annotationId === annotationId
        ? { annotationId: a.annotationId, instruction: instruction, target: a.target, element: a.element, result: a.result }
        : a;
    });
  }

  // markProcessing sets every annotation's result to "processing".
  function markProcessing(queue) {
    return queue.map(function (a) {
      return Object.assign({}, a, { result: { status: "processing" } });
    });
  }

  // markUncertain sets every annotation's result to "unknown" (e.g. after a
  // relay restart where execution may or may not have completed).
  function markUncertain(queue) {
    return queue.map(function (a) {
      return Object.assign({}, a, { result: { status: "unknown" } });
    });
  }

  // applyResults maps a batch of annotationResults onto the queue by permanent
  // annotationId. A missing entry becomes "unknown" (never "done").
  function applyResults(queue, annotationResults) {
    const byId = {};
    for (const r of annotationResults || []) {
      byId[r.annotationId] = r;
    }
    return queue.map(function (a) {
      const r = byId[a.annotationId];
      if (!r) {
        return Object.assign({}, a, { result: { status: "unknown" } });
      }
      if (r.status === "done") {
        return Object.assign({}, a, {
          result: { status: "done", summary: r.summary, verification: r.verification },
        });
      }
      return Object.assign({}, a, { result: { status: "error", error: r.error } });
    });
  }

  return {
    MAX: MAX,
    pageId: pageId,
    serialize: serialize,
    addToQueue: addToQueue,
    removeFromQueue: removeFromQueue,
    updateInstruction: updateInstruction,
    markProcessing: markProcessing,
    markUncertain: markUncertain,
    applyResults: applyResults,
  };
});
