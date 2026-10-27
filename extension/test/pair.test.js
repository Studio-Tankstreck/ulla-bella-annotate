"use strict";

// Unit tests for pair.js (parseUllabellaFile + redeemInvite). Run with Node's
// built-in test runner (no dependencies):
//   node --test test/pair.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const pair = require(path.join(__dirname, "..", "src", "pair.js"));

const VALID = {
  format: "ulla-bella-site",
  version: "1",
  relayUrl: "http://127.0.0.1:8787",
  invite: "ub_invite_disposable_token_only",
};

function parse(text) {
  try {
    return pair.parseUllabellaFile(text);
  } catch (e) {
    return e;
  }
}

test("parse: valid file", () => {
  const r = pair.parseUllabellaFile(JSON.stringify(VALID));
  assert.equal(r.relayUrl, "http://127.0.0.1:8787");
  assert.equal(r.invite, "ub_invite_disposable_token_only");
});

test("parse: not JSON", () => {
  assert.equal(parse("not json").code, "invalid_file");
});

test("parse: non-object JSON", () => {
  assert.equal(parse('"just a string"').code, "invalid_file");
});

test("parse: wrong format", () => {
  const d = Object.assign({}, VALID, { format: "other" });
  assert.equal(parse(JSON.stringify(d)).code, "invalid_format");
});

test("parse: unsupported version", () => {
  const d = Object.assign({}, VALID, { version: "2" });
  assert.equal(parse(JSON.stringify(d)).code, "unsupported_version");
});

test("parse: missing invite", () => {
  const d = Object.assign({}, VALID);
  delete d.invite;
  assert.equal(parse(JSON.stringify(d)).code, "invalid_invite");
});

test("parse: empty invite", () => {
  const d = Object.assign({}, VALID, { invite: "   " });
  assert.equal(parse(JSON.stringify(d)).code, "invalid_invite");
});

test("parse: non-http relayUrl rejected", () => {
  const d = Object.assign({}, VALID, { relayUrl: "ftp://x" });
  assert.equal(parse(JSON.stringify(d)).code, "invalid_relay_url");
});

test("parse: relayUrl with embedded credentials rejected", () => {
  const d = Object.assign({}, VALID, { relayUrl: "http://user:pass@host:8787" });
  assert.equal(parse(JSON.stringify(d)).code, "invalid_relay_url");
});

test("parse: oversized file rejected", () => {
  const big = JSON.stringify(
    Object.assign({}, VALID, { invite: "x".repeat(10000) })
  );
  assert.equal(parse(big).code, "invalid_file");
});

test("parse: extra fields ignored (no escalation)", () => {
  const d = Object.assign({}, VALID, {
    hermesApiKey: "should-be-ignored",
    siteId: "site_hacker",
    deviceCredential: "ubd_evil",
  });
  const r = pair.parseUllabellaFile(JSON.stringify(d));
  assert.equal(r.invite, VALID.invite);
  assert.equal("siteId" in r, false);
});

test("redeem: posts invite and returns config", async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      json: async () => ({
        deviceId: "dev_x",
        siteId: "site_x",
        origin: "https://example.test",
        displayName: "Example",
        deviceCredential: "ubd_secret",
      }),
    };
  };
  const cfg = await pair.redeemInvite("http://127.0.0.1:8787/", "ub_invite", fakeFetch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8787/v1/pair");
  assert.equal(JSON.parse(calls[0].opts.body).invite, "ub_invite");
  assert.equal(cfg.deviceId, "dev_x");
});

test("redeem: surfaces relay error code", async () => {
  const fakeFetch = async () => ({
    ok: false,
    json: async () => ({ error: { code: "invite_already_used", message: "used" } }),
  });
  await assert.rejects(
    () => pair.redeemInvite("http://x", "ub_invite", fakeFetch),
    (e) => e.code === "invite_already_used"
  );
});

test("redeem: rejects malformed relay response", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ deviceId: "dev_x" }), // missing credential/origin
  });
  await assert.rejects(
    () => pair.redeemInvite("http://x", "ub_invite", fakeFetch),
    (e) => e.code === "invalid_pair_response"
  );
});
