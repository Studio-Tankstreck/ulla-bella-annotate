// Ulla-Bella Extension — session model (pure, no DOM, no chrome.*).
//
// A *session* is the unit the user works in: one page of one connected site,
// with its own description, annotation queue, submitted round (job) and the
// tombstones of everything removed from it.
//
// Why it exists (see docs/SESSIONS.md): the queue used to be a single
// `queues[pageId]` entry written with a whole-map read-modify-write and no
// identity of its own. Two tabs (or two pages) then overwrote each other's
// snapshot and a deleted annotation could be written back days later. This
// module makes deletion durable:
//
//   - every removed annotation leaves a TOMBSTONE in the session (`deleted`),
//   - every write is a MERGE where tombstones always win (mergeWrite),
//   - a session is keyed by siteId + page, so sites can never mix,
//   - a cleared session gets a NEW sessionId, and a stale tab can no longer
//     write into the slot it no longer owns.
//
// UMD like lib.js/queue.js: `require()` in tests, `globalThis.UllaBellaSession`
// in the content script.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.UllaBellaSession = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = 2;

  // Storage layout: one key per session, so two tabs on different pages (or
  // different sites) can never clobber each other's document.
  const KEY_PREFIX = "ub.session.";
  // Pre-2.2 storage: { [pageId]: { annotations, job } } for the paired site.
  const LEGACY_KEY = "queues";
  // Marks a legacy entry as already imported, so a deleted annotation can never
  // be re-imported from the old snapshot.
  const MIGRATED_KEY = "ub.migrated.legacy";

  const TERMINAL_JOB = { done: true, error: true, uncertain: true };
  const INTRO_STATES = new Set(["completed", "skipped", "existing"]);

  function newId(prefix) {
    let hex;
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        hex = globalThis.crypto.randomUUID().replace(/-/g, "");
      } else {
        hex = Math.random().toString(16).slice(2) + Date.now().toString(16);
      }
    } catch (_) {
      hex = Math.random().toString(16).slice(2);
    }
    return (prefix || "id") + "_" + hex.slice(0, 16);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function isoOrNull(v) {
    return typeof v === "string" && v ? v : null;
  }

  // sessionKey is the isolation boundary: site + page. Two different sites can
  // never share a session, even when they serve the same path.
  function sessionKey(siteId, pageId) {
    return String(siteId == null || siteId === "" ? "site_unknown" : siteId) + "|" + String(pageId || "");
  }

  function storageKey(siteId, pageId) {
    return KEY_PREFIX + sessionKey(siteId, pageId);
  }

  function isTerminalJob(job) {
    return !!(job && TERMINAL_JOB[job.status]);
  }

  function cleanAnnotation(a) {
    if (!a || typeof a !== "object") return null;
    if (typeof a.annotationId !== "string" || !a.annotationId) return null;
    if (typeof a.instruction !== "string") return null;
    const out = {
      annotationId: a.annotationId,
      instruction: a.instruction,
      target: a.target && typeof a.target === "object" ? a.target : {},
    };
    if (a.result && typeof a.result === "object") out.result = a.result;
    if (typeof a.createdAt === "string") out.createdAt = a.createdAt;
    if (typeof a.updatedAt === "string") out.updatedAt = a.updatedAt;
    return out;
  }

  function cleanJob(j) {
    if (!j || typeof j !== "object" || typeof j.jobId !== "string" || !j.jobId) return null;
    const out = { jobId: j.jobId, status: typeof j.status === "string" && j.status ? j.status : "sending" };
    ["siteId", "connectionId", "origin", "relayUrl", "sessionKey", "agentId"].forEach(function (k) {
      if (typeof j[k] === "string" && j[k]) out[k] = j[k];
    });
    ["submittedAt", "startedAt", "lastChecked", "finishedAt"].forEach(function (k) {
      if (j[k] != null && j[k] !== "") out[k] = j[k];
    });
    if (typeof j.sessionDescription === "string" && j.sessionDescription) {
      out.sessionDescription = j.sessionDescription;
    }
    if (Array.isArray(j.annotationIds)) {
      out.annotationIds = j.annotationIds.filter(function (x) {
        return typeof x === "string";
      });
    }
    return out;
  }

  function empty(meta) {
    const m = meta || {};
    const ts = nowIso();
    const sessionId = m.sessionId || newId("ses");
    return {
      version: VERSION,
      sessionId: sessionId,
      // lineageId is stable for the storage slot and survives clears;
      // generation counts how many times this slot has been cleared. Together
      // they tell a genuinely concurrent first creation apart from a stale
      // session (see mergeWrite) without keeping any history.
      lineageId: m.lineageId || newId("lin"),
      generation: typeof m.generation === "number" && m.generation >= 0 ? m.generation : 0,
      siteId: m.siteId != null ? m.siteId : null,
      siteName: typeof m.siteName === "string" ? m.siteName : "",
      pageId: typeof m.pageId === "string" ? m.pageId : "",
      pageUrl: typeof m.pageUrl === "string" ? m.pageUrl : "",
      description: "",
      descriptionUpdatedAt: null,
      // intro is the state of the "Session description" first step:
      //   null        — not answered yet, ask on the next start
      //   "completed" — the user wrote/confirmed a description
      //   "skipped"   — the user explicitly skipped it (never ask again)
      //   "existing"  — the session already had annotations when this build
      //                 first saw it, so it continues without the step
      intro: null,
      introAt: null,
      annotations: [],
      job: null,
      deleted: {},
      rev: 1,
      createdAt: ts,
      updatedAt: ts,
      clearedAt: null,
      previousSessionId: null,
      legacy: null,
    };
  }

  // normalize turns anything read from storage into a well-formed session. It
  // never throws: unknown/malformed fields are dropped, never guessed.
  function normalize(raw, meta) {
    const m = meta || {};
    const src = raw && typeof raw === "object" ? raw : {};
    const base = empty({
      sessionId: typeof src.sessionId === "string" && src.sessionId ? src.sessionId : null,
      // A document written before lineages existed adopts its own sessionId as
      // the lineage, so old sessions keep one identity across clears.
      lineageId:
        typeof src.lineageId === "string" && src.lineageId
          ? src.lineageId
          : typeof src.sessionId === "string" && src.sessionId
          ? src.sessionId
          : null,
      generation: typeof src.generation === "number" ? src.generation : 0,
      siteId: src.siteId != null ? src.siteId : m.siteId,
      siteName: typeof src.siteName === "string" ? src.siteName : m.siteName,
      pageId: typeof src.pageId === "string" ? src.pageId : m.pageId,
      pageUrl: typeof src.pageUrl === "string" ? src.pageUrl : m.pageUrl,
    });

    const deleted = {};
    if (src.deleted && typeof src.deleted === "object") {
      for (const id of Object.keys(src.deleted)) {
        if (!id) continue;
        const at = src.deleted[id];
        deleted[id] = typeof at === "string" ? at : nowIso();
      }
    }

    const annotations = [];
    const seen = Object.create(null);
    if (Array.isArray(src.annotations)) {
      for (const a of src.annotations) {
        const clean = cleanAnnotation(a);
        if (!clean || deleted[clean.annotationId] || seen[clean.annotationId]) continue;
        seen[clean.annotationId] = true;
        annotations.push(clean);
      }
    }

    return Object.assign(base, {
      description: typeof src.description === "string" ? src.description : "",
      descriptionUpdatedAt: isoOrNull(src.descriptionUpdatedAt),
      intro: INTRO_STATES.has(src.intro) ? src.intro : null,
      introAt: isoOrNull(src.introAt),
      annotations: annotations,
      job: cleanJob(src.job),
      deleted: deleted,
      rev: typeof src.rev === "number" && src.rev >= 0 ? src.rev : 1,
      generation: typeof src.generation === "number" && src.generation >= 0 ? src.generation : 0,
      createdAt: isoOrNull(src.createdAt) || base.createdAt,
      updatedAt: isoOrNull(src.updatedAt) || base.updatedAt,
      clearedAt: isoOrNull(src.clearedAt),
      // Kept so a cleared session can prove it is the SUCCESSOR of the session
      // still stored in its slot (see mergeWrite) — normalize must not drop it.
      previousSessionId: isoOrNull(src.previousSessionId),
      legacy: src.legacy && typeof src.legacy === "object" ? src.legacy : null,
    });
  }

  // fromLegacy imports a pre-2.2 `queues[pageId]` entry. The legacy snapshot is
  // kept as-is (including per-annotation results); the caller marks the entry
  // migrated so it is never imported twice.
  function fromLegacy(entry, meta) {
    const s = empty(meta);
    const annotations = [];
    const list = entry && Array.isArray(entry.annotations) ? entry.annotations : [];
    for (const a of list) {
      const clean = cleanAnnotation(a);
      if (clean) annotations.push(clean);
    }
    const ts = nowIso();
    return Object.assign(s, {
      annotations: annotations,
      job: cleanJob(entry && entry.job),
      rev: 1,
      updatedAt: ts,
      legacy: { migratedAt: ts, annotations: annotations.length },
    });
  }

  function bump(s, patch) {
    return Object.assign({}, s, patch, { rev: (s.rev || 0) + 1, updatedAt: nowIso() });
  }

  // withAnnotations replaces the queue, dropping anything tombstoned. Every
  // mutation goes through this module so rev/updatedAt stay consistent.
  function withAnnotations(s, list) {
    const cur = normalize(s);
    const out = [];
    const seen = Object.create(null);
    for (const a of list || []) {
      const clean = cleanAnnotation(a);
      if (!clean || cur.deleted[clean.annotationId] || seen[clean.annotationId]) continue;
      seen[clean.annotationId] = true;
      out.push(clean);
    }
    return bump(cur, { annotations: out });
  }

  // withInstruction edits one annotation in place (stable id, stable position).
  function withInstruction(s, annotationId, instruction) {
    const cur = normalize(s);
    const ts = nowIso();
    const list = cur.annotations.map(function (a) {
      if (a.annotationId !== annotationId) return a;
      return Object.assign({}, a, { instruction: instruction, updatedAt: ts });
    });
    return bump(cur, { annotations: list });
  }

  function withJob(s, job) {
    const cur = normalize(s);
    return bump(cur, { job: cleanJob(job) });
  }

  function withDescription(s, text) {
    const cur = normalize(s);
    return bump(cur, { description: String(text || ""), descriptionUpdatedAt: nowIso() });
  }

  // withIntro records that the "Session description" first step was answered.
  // Persisting it is what stops the question from coming back for an empty
  // description — a skipped step is a decision, not an unanswered question.
  function withIntro(s, status) {
    const cur = normalize(s);
    const value = INTRO_STATES.has(status) ? status : "skipped";
    return bump(cur, { intro: value, introAt: nowIso() });
  }

  // tombstone records a removal. Tombstones are permanent for the session: they
  // are unioned on every write, so no other writer can put the id back.
  function tombstone(s, annotationId) {
    const cur = normalize(s);
    if (!annotationId) return cur;
    const deleted = Object.assign({}, cur.deleted);
    deleted[annotationId] = nowIso();
    return bump(cur, { deleted: deleted });
  }

  // removeAnnotation is the × button: tombstone + drop in one step.
  function removeAnnotation(s, annotationId) {
    const cur = normalize(s);
    if (!annotationId) return cur;
    const deleted = Object.assign({}, cur.deleted);
    deleted[annotationId] = nowIso();
    return bump(cur, {
      annotations: cur.annotations.filter(function (a) {
        return a.annotationId !== annotationId;
      }),
      deleted: deleted,
    });
  }

  // clear is "Clear session": annotations + description are removed, the
  // session gets a NEW identity and the slot's generation advances (which is
  // what makes every older view of this slot — however stale — refuse to write
  // again; see mergeWrite). A running job is KEPT so the UI can stay honest
  // about it — this never cancels anything server-side.
  function clear(s, opts) {
    const cur = normalize(s);
    const o = opts || {};
    const ts = nowIso();
    return Object.assign({}, cur, {
      sessionId: newId("ses"),
      generation: (cur.generation || 0) + 1,
      description: "",
      descriptionUpdatedAt: ts,
      // Clearing the session also resets the first step: the next round starts
      // with the same "what do you want to do this time?" question.
      intro: null,
      introAt: null,
      annotations: [],
      deleted: {},
      job: o.keepJob === false || isTerminalJob(cur.job) ? null : cur.job,
      clearedAt: ts,
      previousSessionId: cur.sessionId,
      rev: (cur.rev || 0) + 1,
      updatedAt: ts,
    });
  }

  // isVirgin reports a session that has never been cleared and never held a
  // round. Two lineages claiming the same slot can only both be virgin when
  // both were created from an EMPTY slot (a cleared slot keeps its lineage and
  // advances its generation), so merging them cannot resurrect anything.
  function isVirgin(s) {
    return !!s && (s.generation || 0) === 0 && !s.clearedAt;
  }

  function stampOf(job) {
    return (job && (job.submittedAt || job.startedAt)) || "";
  }

  // newerAnnotation prefers the more recently edited copy of one annotation.
  function newerAnnotation(a, b) {
    if (!a) return b;
    if (!b) return a;
    const au = a.updatedAt || "";
    const bu = b.updatedAt || "";
    if (au === bu) return a; // local copy wins a tie
    return bu > au ? b : a;
  }

  function newerJob(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.jobId === b.jobId) {
      if (isTerminalJob(a) && !isTerminalJob(b)) return a;
      return b;
    }
    const sa = stampOf(a);
    const sb = stampOf(b);
    if (sa !== sb) return sb > sa ? b : a;
    if (isTerminalJob(b) !== isTerminalJob(a)) return isTerminalJob(b) ? b : a;
    return b;
  }

  // combine merges two views of the SAME session. `local` wins on ties, the
  // tombstone union is always authoritative, and untouched annotations from
  // either side survive (an addition in another tab is not a deletion here).
  function combine(local, other, revMode) {
    const deleted = Object.assign({}, other.deleted, local.deleted);

    const localById = Object.create(null);
    for (const a of local.annotations) localById[a.annotationId] = a;
    const otherById = Object.create(null);
    for (const a of other.annotations) otherById[a.annotationId] = a;

    const order = [];
    const seen = Object.create(null);
    for (const a of local.annotations) {
      if (deleted[a.annotationId] || seen[a.annotationId]) continue;
      seen[a.annotationId] = true;
      order.push(a.annotationId);
    }
    for (const a of other.annotations) {
      if (deleted[a.annotationId] || seen[a.annotationId]) continue;
      seen[a.annotationId] = true;
      order.push(a.annotationId);
    }

    const annotations = order.map(function (id) {
      return newerAnnotation(localById[id], otherById[id]);
    });

    const lu = local.descriptionUpdatedAt || "";
    const ou = other.descriptionUpdatedAt || "";
    let description = local.description;
    let descriptionUpdatedAt = local.descriptionUpdatedAt;
    if (ou > lu) {
      description = other.description;
      descriptionUpdatedAt = other.descriptionUpdatedAt;
    }

    // The first step is answered at most once per session: a set state always
    // beats "not answered", and the later of two answers wins. Otherwise an
    // old tab (or an empty description) could make the question come back.
    let intro = local.intro;
    let introAt = local.introAt;
    if (other.intro && (!local.intro || (other.introAt || "") > (local.introAt || ""))) {
      intro = other.intro;
      introAt = other.introAt;
    }

    const maxRev = Math.max(local.rev || 0, other.rev || 0);
    return Object.assign({}, local, {
      annotations: annotations,
      deleted: deleted,
      job: newerJob(other.job, local.job),
      description: description,
      descriptionUpdatedAt: descriptionUpdatedAt,
      intro: intro,
      introAt: introAt,
      createdAt: other.createdAt || local.createdAt,
      clearedAt: (other.clearedAt || "") > (local.clearedAt || "") ? other.clearedAt : local.clearedAt,
      legacy: local.legacy || other.legacy || null,
      rev: revMode === "max" ? maxRev : maxRev + 1,
      updatedAt: nowIso(),
    });
  }

  // mergeWrite is the ONLY write path. `stored` is what is in the slot right
  // now; `local` is this tab's document. It returns { session, write, reason }:
  //   write:false  → adopt `session`, never write (the slot belongs to a newer
  //                  generation or to another lineage),
  //   write:true   → write `session` (a merge, a successor replacement, or a
  //                  genuine first creation).
  //
  // Ordering rule (bounded, no history): one lineage per slot, and a monotonic
  // `generation` that only clear() advances.
  //   same lineage, same generation → merge (tombstones always win)
  //   same lineage, older generation → REFUSE (a view from before a clear)
  //   same lineage, newer generation → the caller cleared; replace the slot
  //   different lineage, both generation 0 → concurrent first creation; merge
  //   different lineage otherwise → REFUSE (the slot has a later generation)
  // A document from before a clear can therefore never write its annotations
  // back, no matter how many times the session has been cleared since.
  function mergeWrite(storedRaw, localRaw) {
    const local = normalize(localRaw);
    const stored =
      storedRaw && typeof storedRaw === "object" && Object.keys(storedRaw).length > 0
        ? normalize(storedRaw, {
            siteId: local.siteId,
            siteName: local.siteName,
            pageId: local.pageId,
            pageUrl: local.pageUrl,
          })
        : null;

    if (!stored) return { session: local, write: true, reason: "create" };

    if (stored.lineageId !== local.lineageId) {
      if (isVirgin(stored) && isVirgin(local)) {
        // Two tabs created a session for the same empty slot at the same time:
        // keep the slot's identity (it is already stored) and keep both sides.
        return {
          session: combine(
            Object.assign({}, local, {
              sessionId: stored.sessionId,
              lineageId: stored.lineageId,
              previousSessionId: null,
            }),
            stored,
            "next"
          ),
          write: true,
          reason: "concurrent-create",
        };
      }
      return { session: stored, write: false, reason: "foreign-session" };
    }

    const localGen = local.generation || 0;
    const storedGen = stored.generation || 0;
    if (localGen < storedGen) return { session: stored, write: false, reason: "stale-generation" };
    if (localGen > storedGen) {
      return {
        session: Object.assign({}, local, {
          rev: Math.max(local.rev || 0, stored.rev || 0) + 1,
          updatedAt: nowIso(),
        }),
        write: true,
        reason: "successor",
      };
    }
    return { session: combine(local, stored, "next"), write: true, reason: "merge" };
  }

  // reconcile applies a change another context wrote (chrome.storage.onChanged)
  // to the in-memory session. It never writes. A cleared generation always wins
  // over an older view; a stale revision never wins over a newer one.
  function reconcile(localRaw, incomingRaw) {
    const local = normalize(localRaw);
    const incoming = normalize(incomingRaw, {
      siteId: local.siteId,
      siteName: local.siteName,
      pageId: local.pageId,
      pageUrl: local.pageUrl,
    });
    const localGen = local.generation || 0;
    const inGen = incoming.generation || 0;
    if (incoming.lineageId !== local.lineageId) {
      return inGen >= localGen ? incoming : local;
    }
    if (inGen > localGen) return incoming;
    if (inGen < localGen) return local;
    if ((incoming.rev || 0) < (local.rev || 0)) return local;
    return combine(local, incoming, "max");
  }

  return {
    VERSION: VERSION,
    KEY_PREFIX: KEY_PREFIX,
    LEGACY_KEY: LEGACY_KEY,
    MIGRATED_KEY: MIGRATED_KEY,
    newSessionId: function () {
      return newId("ses");
    },
    sessionKey: sessionKey,
    storageKey: storageKey,
    isTerminalJob: isTerminalJob,
    isVirgin: isVirgin,
    empty: empty,
    normalize: normalize,
    fromLegacy: fromLegacy,
    withAnnotations: withAnnotations,
    withInstruction: withInstruction,
    withJob: withJob,
    withDescription: withDescription,
    withIntro: withIntro,
    tombstone: tombstone,
    removeAnnotation: removeAnnotation,
    clear: clear,
    mergeWrite: mergeWrite,
    reconcile: reconcile,
  };
});
