"use strict";

// Unit tests for relay-policy.js (Part 7: .ullabella relayUrl authorization).
// Run with Node's built-in test runner:
//   node --test test/relay-policy.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const policy = require(path.join(__dirname, "..", "src", "relay-policy.js"));

test("relayOrigin: normalizes to scheme://host[:port]", () => {
  assert.equal(policy.relayOrigin("https://relay.example.com"), "https://relay.example.com");
  assert.equal(policy.relayOrigin("https://relay.example.com/v1/pair"), "https://relay.example.com");
  assert.equal(policy.relayOrigin("https://relay.example.com"), "https://relay.example.com");
});

test("relayOrigin: rejects credentials", () => {
  assert.equal(policy.relayOrigin("https://user:pass@relay.example.com"), null);
});

test("relayOrigin: rejects non-http(s) schemes", () => {
  assert.equal(policy.relayOrigin("ftp://relay.example.com"), null);
  assert.equal(policy.relayOrigin("javascript:alert(1)"), null);
});

test("relayOrigin: rejects unparseable input", () => {
  assert.equal(policy.relayOrigin("not a url"), null);
});

test("isAllowedRelay: placeholder origin is not allowed", () => {
  // The placeholder token is replaced at packaging time; it must never match.
  assert.equal(policy.isAllowedRelay("__RELAY_ORIGIN__"), false);
});

test("isAllowedRelay: exact-origin match only", () => {
  const saved = policy.ALLOWED_RELAY_ORIGINS.slice();
  policy.ALLOWED_RELAY_ORIGINS.length = 0;
  policy.ALLOWED_RELAY_ORIGINS.push("https://relay.example.com");
  try {
    assert.equal(policy.isAllowedRelay("https://relay.example.com"), true);
    assert.equal(policy.isAllowedRelay("https://relay.example.com/v1/pair"), true);
    // Scheme, host, or port must match exactly. Default ports normalize away
    // under URL.origin (https:443 == https), so use a real non-default port.
    assert.equal(policy.isAllowedRelay("http://relay.example.com"), false);
    assert.equal(policy.isAllowedRelay("https://relay.example.com:8443"), false);
    assert.equal(policy.isAllowedRelay("https://evil.test"), false);
  } finally {
    policy.ALLOWED_RELAY_ORIGINS.length = 0;
    for (const o of saved) policy.ALLOWED_RELAY_ORIGINS.push(o);
  }
});

test("isAllowedRelay: empty allowlist denies everything", () => {
  const saved = policy.ALLOWED_RELAY_ORIGINS.slice();
  policy.ALLOWED_RELAY_ORIGINS.length = 0;
  try {
    assert.equal(policy.isAllowedRelay("https://relay.example.com"), false);
  } finally {
    for (const o of saved) policy.ALLOWED_RELAY_ORIGINS.push(o);
  }
});

test("isAllowedRelay: portable build accepts only a granted origin", () => {
  const saved = policy.ALLOWED_RELAY_ORIGINS.slice();
  policy.ALLOWED_RELAY_ORIGINS.length = 0;
  try {
    const relay = "https://relay.customer.test";
    // Nothing granted: the file alone is not enough.
    assert.equal(policy.isAllowedRelay(relay, { portable: true, grantedOrigins: [] }), false);
    // Granted: accepted.
    assert.equal(
      policy.isAllowedRelay(relay, { portable: true, grantedOrigins: ["https://relay.customer.test"] }),
      true
    );
    // A grant for another origin never leaks across.
    assert.equal(
      policy.isAllowedRelay(relay, { portable: true, grantedOrigins: ["https://relay.other.test"] }),
      false
    );
    // The same grant in a canonical build authorises nothing.
    assert.equal(
      policy.isAllowedRelay(relay, { portable: false, grantedOrigins: ["https://relay.customer.test"] }),
      false
    );
  } finally {
    policy.ALLOWED_RELAY_ORIGINS.length = 0;
    for (const o of saved) policy.ALLOWED_RELAY_ORIGINS.push(o);
  }
});

test("isAllowedRelay: the source tree ships the non-portable default", () => {
  // Packaging rewrites these two values; unsubstituted source must never pair.
  assert.equal(policy.PORTABLE, false);
  assert.deepEqual(policy.ALLOWED_RELAY_ORIGINS, ["__RELAY_ORIGIN__"]);
  assert.equal(policy.isAllowedRelay("https://relay.customer.test", { grantedOrigins: ["https://relay.customer.test"] }), false);
});
