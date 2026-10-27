// Ulla-Bella Extension — Protocol V1 client helpers (pure, no DOM).
//
// Builds the exact V1 payloads the extension submits. Dependency-free and
// shared between the content script, the service worker, and the Node unit
// tests. Protocol V1 is defined in protocol/*.schema.json — these helpers never
// redefine it, they only construct conforming instances.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.UllaBella = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCHEMA_VERSION = "1";

  // newId returns a random correlation id with the given prefix (hex, matching
  // the Go proto.NewID shape). Only uniqueness within a session matters.
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
    return prefix + "_" + hex.slice(0, 16);
  }

  // originMatches reports whether url is within origin (scheme + host,
  // including port). Mirrors the Relay/Adapter sameOrigin check so the
  // extension refuses to activate outside the configured Site.
  function originMatches(origin, url) {
    try {
      const a = new URL(origin);
      const b = new URL(url);
      return a.protocol === b.protocol && a.host === b.host;
    } catch (_) {
      return false;
    }
  }

  // isSafeSelectorToken limits tokens to characters valid in a simple CSS
  // identifier fragment. Anything else is skipped rather than emitted as a
  // broken selector — the selector is a hint only, never sole identity.
  function isSafeSelectorToken(token) {
    return typeof token === "string" && /^[A-Za-z0-9_-]+$/.test(token) && token !== "";
  }

  // classNameArray normalizes DOMTokenList / Array / null into a plain array.
  function classNameArray(cls) {
    if (!cls) return [];
    if (Array.isArray(cls)) return cls.map(String);
    const out = [];
    for (let i = 0; i < cls.length; i++) out.push(String(cls[i]));
    return out;
  }

  // buildSelector returns a best-effort CSS selector for el: #id, else
  // tag.class1.class2, else the bare tag. Deliberately not a uniqueness engine.
  function buildSelector(el) {
    const tag = String((el && el.tagName) || "div").toLowerCase();
    const id = el && el.id;
    if (isSafeSelectorToken(id)) return "#" + id;
    const classes = classNameArray(el && el.classList).filter(isSafeSelectorToken);
    if (classes.length > 0) return tag + "." + classes.join(".");
    return tag;
  }

  // siblingIndex returns the 1-based position of el among same-tag siblings.
  function siblingIndex(el) {
    const parent = el && el.parentElement;
    if (!parent || !parent.children) return 1;
    let idx = 0;
    const tag = el.tagName;
    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i];
      if (child === el) return idx + 1;
      if (child.tagName === tag) idx++;
    }
    return idx + 1;
  }

  // buildDomPath returns a best-effort element path like
  // "html > body[1] > header[1] > h1[1]". Hint only.
  function buildDomPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.tagName && String(cur.tagName).toLowerCase() !== "html") {
      parts.unshift(String(cur.tagName).toLowerCase() + "[" + siblingIndex(cur) + "]");
      cur = cur.parentElement || null;
    }
    parts.unshift("html");
    return parts.join(" > ");
  }

  // buildAnnotation assembles a Protocol V1 Annotation. instruction is the
  // user's natural-language change; target is a plain object with url required
  // and the best-effort hint fields. Empty hints are omitted (schema-valid).
  function buildAnnotation(instruction, target, annotationId) {
    const t = { url: target.url };
    if (target.pageTitle) t.pageTitle = target.pageTitle;
    if (target.elementType) t.elementType = target.elementType;
    if (target.visibleText) t.visibleText = target.visibleText;
    if (target.selector) t.selector = target.selector;
    if (target.domPath) t.domPath = target.domPath;
    if (target.rect) t.rect = target.rect;

    const annotation = {
      annotationId: annotationId || newId("ann"),
      instruction: instruction,
      target: t,
    };
    if (target.nearbyText) {
      annotation.context = { nearbyText: target.nearbyText };
    }
    return annotation;
  }

  // buildJob assembles a Protocol V1 Job from one or more annotations.
  // Accepts a single annotation or an array (back-compat), normalizing to an
  // array. The jobId is client-generated and stable per round.
  function buildJob(config, annotations, context) {
    const list = Array.isArray(annotations) ? annotations : [annotations];
    const job = {
      jobId: newId("job"),
      siteId: config.siteId,
      deviceId: config.deviceId,
      createdAt: new Date().toISOString(),
      annotations: list,
    };
    // Optional job-wide context (the user's session description). It is omitted
    // entirely when empty, so jobs submitted without one are identical to the
    // pre-etapp-2 payload and older relays/adapters keep working.
    const session = context && typeof context.session === "string" ? context.session.trim() : "";
    if (session) job.context = { session: session };
    return job;
  }

  // activityLabel maps a controlled activity kind (from a working Result's
  // activity object) to its user-facing label. The label is resolved through the
  // caller's translator (i18n.t) so it follows the chosen UI language; this
  // module stays free of copy. Returns null for an unknown or absent kind so the
  // UI can show a neutral "activity unavailable".
  function activityLabel(kind, t) {
    switch (kind) {
      case "starting": return t("activityStarting");
      case "working": return t("activityWorking");
      case "using_tools": return t("activityUsingTools");
      case "thinking": return t("activityThinking");
      case "waiting_for_approval": return t("activityWaitingApproval");
      case "verifying": return t("activityVerifying");
      default: return null;
    }
  }

  // buildEnvelope wraps a payload in the V1 envelope.
  function buildEnvelope(messageType, payload) {
    return {
      schemaVersion: SCHEMA_VERSION,
      messageType: messageType,
      id: newId("msg"),
      timestamp: new Date().toISOString(),
      payload: payload,
    };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    newId: newId,
    originMatches: originMatches,
    buildSelector: buildSelector,
    buildDomPath: buildDomPath,
    buildAnnotation: buildAnnotation,
    buildJob: buildJob,
    buildEnvelope: buildEnvelope,
    activityLabel: activityLabel,
  };
});
