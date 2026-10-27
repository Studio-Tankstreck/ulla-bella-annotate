"use strict";

// Portable Relay mode (RELAY_PORTABLE=1 packaging).
//
// A portable build bakes no Relay origin in: host_permissions is empty at build
// time, and the origin from an imported .ullabella file is accepted ONLY while
// this extension holds the host permission the user granted for it. An imported
// file on its own must never widen the extension's network access, so the refusal
// happens BEFORE any request leaves the browser.

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeChromeShim, loadBackground, reply } = require("./support/worker-shim");

const RELAY = "https://relay.customer.test";

function seed() {
  return { connections: {}, "ub.migrated.connections": { at: 1, version: 1 } };
}

function stubPair(shim) {
  shim._fetch = async function (url, opts) {
    shim._fetches.push({ url: url, opts: opts });
    if (url.indexOf("/v1/pair") !== -1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          deviceId: "dev_new",
          siteId: "site_new",
          origin: "https://site.test",
          displayName: "Site",
          deviceCredential: "ubd_new",
        }),
      };
    }
    return { ok: false, status: 599, json: async () => ({}) };
  };
  globalThis.fetch = shim._fetch;
}

test("portable: an imported relay is refused without a granted origin", async () => {
  const shim = makeChromeShim(seed());
  loadBackground(shim);
  globalThis.UllaBellaRelayPolicy.PORTABLE = true;
  stubPair(shim);

  const resp = await reply(shim, { type: "redeemInvite", relayUrl: RELAY, invite: "inv_1" });

  assert.equal(resp.ok, false);
  assert.equal(resp.error.code, "relay_not_allowed");
  assert.deepEqual(
    shim._fetches.filter((f) => String(f.url).indexOf("/v1/pair") !== -1),
    [],
    "no pairing request may leave the browser before the origin is granted"
  );
  assert.deepEqual(shim._storage.connections, {}, "nothing was stored");
});

test("portable: a granted relay origin is accepted and the connection is stored", async () => {
  const shim = makeChromeShim(seed());
  loadBackground(shim);
  globalThis.UllaBellaRelayPolicy.PORTABLE = true;
  shim.permissions._granted.push(RELAY + "/*");
  stubPair(shim);

  const resp = await reply(shim, { type: "redeemInvite", relayUrl: RELAY, invite: "inv_1" });

  assert.equal(resp.ok, true, resp.error && resp.error.message);
  const pairCall = shim._fetches.filter((f) => String(f.url).indexOf("/v1/pair") !== -1);
  assert.equal(pairCall.length, 1);
  assert.equal(pairCall[0].url, RELAY + "/v1/pair");
  const stored = Object.values(shim._storage.connections);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].relayUrl, RELAY);
  assert.equal(stored[0].siteId, "site_new");
});

test("portable: a grant for a DIFFERENT origin does not authorise this one", async () => {
  const shim = makeChromeShim(seed());
  loadBackground(shim);
  globalThis.UllaBellaRelayPolicy.PORTABLE = true;
  shim.permissions._granted.push("https://relay.other.test/*");
  stubPair(shim);

  const resp = await reply(shim, { type: "redeemInvite", relayUrl: RELAY, invite: "inv_1" });

  assert.equal(resp.ok, false);
  assert.equal(resp.error.code, "relay_not_allowed");
});

test("canonical build: a granted origin is still not enough", async () => {
  const shim = makeChromeShim(seed());
  loadBackground(shim);
  // node --test shares one module instance per file, so reset the build flag a
  // portable test set earlier: this case is the packaged-origin build.
  globalThis.UllaBellaRelayPolicy.PORTABLE = false;
  shim.permissions._granted.push(RELAY + "/*");
  stubPair(shim);

  const resp = await reply(shim, { type: "redeemInvite", relayUrl: RELAY, invite: "inv_1" });

  assert.equal(resp.ok, false, "only the baked origin may ever be used");
  assert.equal(resp.error.code, "relay_not_allowed");
});
