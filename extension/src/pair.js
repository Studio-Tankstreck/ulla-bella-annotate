// Ulla-Bella Extension — .ullabella pairing helpers (pure, no chrome API).
//
// parseUllabellaFile validates an imported .ullabella file as UNTRUSTED input
// and extracts only {relayUrl, invite}. redeemInvite posts the invite to the
// Relay's /v1/pair endpoint. Dependency-free and shared between the popup, the
// service worker, and the Node unit tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.UllaBellaPair = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FORMAT = "ulla-bella-site";
  const VERSION = "1";
  const MAX_FILE_BYTES = 8192;
  const MAX_RELAY_URL_LEN = 2048;
  const MAX_INVITE_LEN = 4096;

  function fail(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  // parseUllabellaFile validates the file as untrusted input and returns
  // {relayUrl, invite}. It throws Error with a stable `.code`:
  // invalid_file / invalid_format / unsupported_version / invalid_relay_url /
  // invalid_invite. It deliberately accepts NO other fields and gives no
  // escalation path (no paths, no credentials, no HTML, no site overrides).
  function parseUllabellaFile(text) {
    if (typeof text !== "string") throw fail("invalid_file", "File is not text.");
    if (text.length > MAX_FILE_BYTES) throw fail("invalid_file", "File is too large.");
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw fail("invalid_file", "File is not valid JSON.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw fail("invalid_file", "File must be a JSON object.");
    }
    if (data.format !== FORMAT) throw fail("invalid_format", "Unknown file format.");
    if (data.version !== VERSION) throw fail("unsupported_version", "Unsupported file version.");
    if (typeof data.relayUrl !== "string" || data.relayUrl.length === 0 || data.relayUrl.length > MAX_RELAY_URL_LEN) {
      throw fail("invalid_relay_url", "File has an invalid Relay URL.");
    }
    let u;
    try {
      u = new URL(data.relayUrl);
    } catch (_) {
      throw fail("invalid_relay_url", "File has an invalid Relay URL.");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw fail("invalid_relay_url", "Relay URL must be http or https.");
    }
    if (u.username || u.password) {
      throw fail("invalid_relay_url", "Relay URL must not contain credentials.");
    }
    if (typeof data.invite !== "string" || data.invite.trim() === "" || data.invite.length > MAX_INVITE_LEN) {
      throw fail("invalid_invite", "File has no valid invite token.");
    }
    return { relayUrl: data.relayUrl, invite: data.invite.trim() };
  }

  // redeemInvite posts the invite to POST <relayUrl>/v1/pair and returns the
  // Relay's browser configuration {deviceId, siteId, origin, displayName,
  // deviceCredential}. Throws with the Relay's stable error code when the
  // invite is invalid/used/expired, or invalid_pair_response if the Relay's
  // answer is malformed. fetchImpl is injectable for tests.
  async function redeemInvite(relayUrl, invite, fetchImpl) {
    const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
    if (!f) throw fail("relay_unreachable", "No fetch available.");
    const base = String(relayUrl).replace(/\/+$/, "");
    const resp = await f(base + "/v1/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invite: invite }),
    });
    let body = {};
    try {
      body = await resp.json();
    } catch (_) {
      body = {};
    }
    if (!resp.ok) {
      const err = (body && body.error) || {};
      throw fail(err.code || "relay_error", err.message || "The Relay rejected the invite.");
    }
    for (const k of ["deviceId", "siteId", "origin", "deviceCredential"]) {
      if (typeof body[k] !== "string" || body[k] === "") {
        throw fail("invalid_pair_response", "The Relay returned an invalid configuration.");
      }
    }
    return body;
  }

  return { FORMAT: FORMAT, VERSION: VERSION, parseUllabellaFile: parseUllabellaFile, redeemInvite: redeemInvite };
});
