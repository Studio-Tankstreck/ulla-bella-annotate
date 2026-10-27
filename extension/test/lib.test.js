"use strict";

// Ulla-Bella Extension — unit tests for the pure Protocol V1 helpers (lib.js).
// Run with Node's built-in test runner (no dependencies):
//   node --test test/lib.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ub = require(path.join(__dirname, "..", "src", "lib.js"));
const i18n = require(path.join(__dirname, "..", "src", "i18n.js"));

test("originMatches: same origin, different path", () => {
  assert.equal(ub.originMatches("http://site.example.com:8080", "http://site.example.com:8080/services"), true);
});

test("originMatches: scheme mismatch", () => {
  assert.equal(ub.originMatches("http://site.example.com:8080", "https://relay.example.com:8080/services"), false);
});

test("originMatches: port mismatch", () => {
  assert.equal(ub.originMatches("http://site.example.com:8080", "http://relay.example.com:8081/services"), false);
});

test("originMatches: host mismatch", () => {
  assert.equal(ub.originMatches("http://site.example.com:8080", "http://evil.test/services"), false);
});

test("originMatches: canonical https origin", () => {
  assert.equal(ub.originMatches("https://example.test", "https://example.test/services"), true);
});

test("originMatches: invalid url returns false", () => {
  assert.equal(ub.originMatches("http://x", "not a url"), false);
});

test("buildSelector: id wins", () => {
  assert.equal(ub.buildSelector({ tagName: "H1", id: "hero", classList: [] }), "#hero");
});

test("buildSelector: tag + classes", () => {
  assert.equal(
    ub.buildSelector({ tagName: "H1", id: "", classList: ["hero-title", "big"] }),
    "h1.hero-title.big"
  );
});

test("buildSelector: bare tag when no id/class", () => {
  assert.equal(ub.buildSelector({ tagName: "DIV", id: "", classList: [] }), "div");
});

test("buildSelector: unsafe id/class tokens are skipped", () => {
  assert.equal(
    ub.buildSelector({ tagName: "DIV", id: "a b", classList: ["x", "has space"] }),
    "div.x"
  );
});

test("buildDomPath: h1 nested in header/body", () => {
  const html = { tagName: "HTML", children: [], parentElement: null };
  const body = { tagName: "BODY", children: [], parentElement: html };
  const header = { tagName: "HEADER", children: [], parentElement: body };
  const h1 = { tagName: "H1", children: [], parentElement: header };
  html.children = [body];
  body.children = [header];
  header.children = [h1];

  assert.equal(ub.buildDomPath(h1), "html > body[1] > header[1] > h1[1]");
});

test("buildDomPath: sibling index counts only same tag", () => {
  const html = { tagName: "HTML", children: [], parentElement: null };
  const body = { tagName: "BODY", children: [], parentElement: html };
  const p1 = { tagName: "P", children: [], parentElement: body };
  const h2 = { tagName: "H2", children: [], parentElement: body };
  const p2 = { tagName: "P", children: [], parentElement: body };
  html.children = [body];
  body.children = [p1, h2, p2];

  // p2 is the 2nd <p>, even though it is the 3rd child.
  assert.equal(ub.buildDomPath(p2), "html > body[1] > p[2]");
});

test("buildAnnotation: emits required + hint fields, omits empty", () => {
  const target = {
    url: "http://site.example.com:8080/services",
    pageTitle: "Tjänster — Example Test",
    elementType: "h1",
    visibleText: "Tjänster",
    selector: "h1",
    domPath: "html > body[1] > header[1] > h1[1]",
    rect: { x: 0, y: 120, width: 640, height: 48 },
    nearbyText: "Vi hjälper företag att växa.",
  };
  const ann = ub.buildAnnotation("Change this heading to Our Services", target);

  assert.match(ann.annotationId, /^ann_[0-9a-f]{16}$/);
  assert.equal(ann.instruction, "Change this heading to Our Services");
  assert.equal(ann.target.url, target.url);
  assert.equal(ann.target.elementType, "h1");
  assert.equal(ann.target.visibleText, "Tjänster");
  assert.equal(ann.target.selector, "h1");
  assert.deepEqual(ann.target.rect, target.rect);
  assert.equal(ann.context.nearbyText, "Vi hjälper företag att växa.");
});

test("buildAnnotation: omits empty hints and context", () => {
  const ann = ub.buildAnnotation("Do it", { url: "http://x/services" });
  assert.equal(ann.target.url, "http://x/services");
  assert.equal("pageTitle" in ann.target, false);
  assert.equal("context" in ann, false);
});

test("buildAnnotation: preserves a supplied annotationId", () => {
  const ann = ub.buildAnnotation("Do it", { url: "http://x/services" }, "ann_custom");
  assert.equal(ann.annotationId, "ann_custom");
});

test("buildJob: one annotation, static identities", () => {
  const cfg = { siteId: "site_01j7x9k2m", deviceId: "dev_01j7xa1b3" };
  const ann = ub.buildAnnotation("Change it", { url: "http://x/services" });
  const job = ub.buildJob(cfg, ann);

  assert.match(job.jobId, /^job_[0-9a-f]{16}$/);
  assert.equal(job.siteId, cfg.siteId);
  assert.equal(job.deviceId, cfg.deviceId);
  assert.equal(job.annotations.length, 1);
  assert.deepEqual(job.annotations[0], ann);
  // createdAt must be a valid ISO-8601 timestamp.
  assert.ok(!Number.isNaN(Date.parse(job.createdAt)));
});

test("buildEnvelope: V1 envelope shape", () => {
  const payload = { jobId: "job_x" };
  const env = ub.buildEnvelope("job", payload);

  assert.equal(env.schemaVersion, "1");
  assert.equal(env.messageType, "job");
  assert.match(env.id, /^msg_[0-9a-f]{16}$/);
  assert.ok(!Number.isNaN(Date.parse(env.timestamp)));
  assert.deepEqual(env.payload, payload);
});

test("activityLabel maps controlled kinds to user-facing labels", () => {
  // The label text comes from the locale files (English here), resolved through
  // the translator lib.js is given.
  assert.equal(ub.activityLabel("starting", i18n.t), "Starting");
  assert.equal(ub.activityLabel("working", i18n.t), "Working");
  assert.equal(ub.activityLabel("using_tools", i18n.t), "Executing tools");
  assert.equal(ub.activityLabel("thinking", i18n.t), "Thinking");
  assert.equal(ub.activityLabel("waiting_for_approval", i18n.t), "Waiting for approval");
  assert.equal(ub.activityLabel("verifying", i18n.t), "Verifying");
});

test("activityLabel returns null for unknown or absent kinds", () => {
  assert.equal(ub.activityLabel("bogus", i18n.t), null);
  assert.equal(ub.activityLabel("", i18n.t), null);
  assert.equal(ub.activityLabel(undefined, i18n.t), null);
});

test("SCHEMA_VERSION is 1", () => {
  assert.equal(ub.SCHEMA_VERSION, "1");
});
