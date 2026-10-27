"use strict";

// Pure unit tests for the job-monitoring state machine (monitor.js). These pin
// the transient-network-error vs terminal distinction and the badge mapping.

const test = require("node:test");
const assert = require("node:assert/strict");
const monitor = require("../src/monitor.js");

test("badgeFor maps each status to its badge text", () => {
  assert.equal(monitor.badgeFor("accepted"), "…");
  assert.equal(monitor.badgeFor("working"), "…");
  assert.equal(monitor.badgeFor("paused"), "…");
  assert.equal(monitor.badgeFor("done"), "✓");
  assert.equal(monitor.badgeFor("error"), "!");
  assert.equal(monitor.badgeFor("uncertain"), "?");
  assert.equal(monitor.badgeFor(""), "");
  assert.equal(monitor.badgeFor("bogus"), "");
});

test("isTerminal recognizes only done and error", () => {
  assert.equal(monitor.isTerminal("done"), true);
  assert.equal(monitor.isTerminal("error"), true);
  assert.equal(monitor.isTerminal("working"), false);
  assert.equal(monitor.isTerminal("accepted"), false);
  assert.equal(monitor.isTerminal("paused"), false);
  assert.equal(monitor.isTerminal("uncertain"), false);
});

test("isUncertain recognizes only the explicit uncertain status", () => {
  assert.equal(monitor.isUncertain("uncertain"), true);
  assert.equal(monitor.isUncertain("error"), false);
  assert.equal(monitor.isUncertain("done"), false);
});

test("pollOnce returns the terminal status on a normal response", async () => {
  const fetchFn = async () => ({ json: async () => ({ payload: { status: "done", summary: "x" } }) });
  const r = await monitor.pollOnce(fetchFn, "http://relay", {}, "job1");
  assert.deepEqual(r, { transient: false, status: "done", payload: { status: "done", summary: "x" } });
});

test("pollOnce reports a transient network error, NOT a job failure", async () => {
  const fetchFn = async () => { throw new Error("network down"); };
  const r = await monitor.pollOnce(fetchFn, "http://relay", {}, "job1");
  assert.equal(r.transient, true);
  assert.equal(r.code, "relay_unreachable");
  assert.equal(r.status, undefined);
});

test("pollOnce tolerates a non-JSON response body", async () => {
  const fetchFn = async () => ({ json: async () => { throw new Error("bad json"); } });
  const r = await monitor.pollOnce(fetchFn, "http://relay", {}, "job1");
  assert.deepEqual(r, { transient: false, status: null, payload: {} });
});

test("pollOnce distinguishes terminal error from transient error", async () => {
  // A terminal "error" comes back as a normal (non-transient) poll.
  const terminalFetch = async () => ({ json: async () => ({ payload: { status: "error", error: { code: "edit_failed", message: "nope" } } }) });
  const r = await monitor.pollOnce(terminalFetch, "http://relay", {}, "job1");
  assert.equal(r.transient, false);
  assert.equal(r.status, "error");
  assert.equal(monitor.isTerminal(r.status), true);
});
