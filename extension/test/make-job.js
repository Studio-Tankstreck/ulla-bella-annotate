"use strict";

// Ulla-Bella — generates the browser-shaped Job envelope (the exact payload the
// extension submits) as JSON on stdout. Used to produce
// protocol/fixtures/browser-job.json and to inspect the payload without Chrome.
//
//   node test/make-job.js                       # default example origin
//   SITE_ORIGIN=http://X node test/make-job.js
//
// Requires Node 18+ (global fetch is not used here, but lib.js needs crypto).
const path = require("path");
const ub = require(path.join(__dirname, "..", "src", "lib.js"));

const origin = process.env.SITE_ORIGIN || "https://example.test";
// The browser-side identities the Job carries (the service worker fills these
// from the paired Site in chrome.storage.local at runtime).
const site = {
  siteId: process.env.SITE_ID || "site_01j7x9k2m",
  deviceId: process.env.DEVICE_ID || "dev_01j7xa1b3",
};

// Simulated capture of the canonical H1. Mirrors content.js capture() for the
// Task 08 test page; the real DOM capture happens in Chrome and is logged to
// the console there.
const target = {
  url: origin + "/services",
  pageTitle: "Tjänster — Example Test",
  elementType: "h1",
  visibleText: "Tjänster",
  selector: "h1",
  domPath: "html > body[1] > header[1] > h1[1]",
  rect: { x: 0, y: 120, width: 640, height: 48 },
  nearbyText: "Vi hjälper företag att växa.",
};

const annotation = ub.buildAnnotation("Change this heading to Our Services", target);
const job = ub.buildJob(site, annotation);
const envelope = ub.buildEnvelope("job", job);

process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
