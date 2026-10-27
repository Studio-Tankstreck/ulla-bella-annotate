"use strict";

// Regression test: the service worker calls chrome.alarms at the top level
// (chrome.alarms.onAlarm.addListener). Without the "alarms" permission the
// namespace is undefined and the whole worker crashes on startup, taking the
// green icon, "Start editing" and hover highlighting with it (Task 2 regression).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")
);

test("manifest declares every permission the service worker requires", () => {
  const perms = manifest.permissions || [];
  for (const p of ["storage", "scripting", "activeTab", "tabs", "alarms"]) {
    assert.ok(perms.includes(p), 'manifest.permissions is missing "' + p + '"');
  }
});
