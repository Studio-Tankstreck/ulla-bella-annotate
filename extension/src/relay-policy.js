// Ulla-Bella Extension — Relay origin policy.
//
// The extension only ever talks to a Relay whose origin (scheme://host[:port])
// is authorised. A .ullabella file whose relayUrl points anywhere else is
// rejected BEFORE any network request, so an imported file can never redirect
// the extension's network access to an arbitrary origin.
//
// Two build modes (scripts/package-extension.sh):
//   canonical — RELAY_ORIGIN=<origin> bakes exactly one origin in; that origin
//               is the only Relay the build may ever talk to.
//   portable  — RELAY_PORTABLE=1 bakes no origin in. The user grants the Relay
//               origin from their own .ullabella file when they import it, and
//               only an origin this extension actually holds a host permission
//               for is accepted.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.UllaBellaRelayPolicy = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Canonical Relay origins permitted for pairing. The packaging script
  // substitutes RELAY_ORIGIN here (e.g. "https://relay.example.com"); a portable
  // build ships an empty list.
  const ALLOWED_RELAY_ORIGINS = ["__RELAY_ORIGIN__"];

  // PORTABLE is a build constant: the packaging script rewrites the quoted token
  // below to "true" for a portable build. It stays a valid JS string in the
  // source tree so the module loads unchanged in tests and unpacked dev builds.
  const PORTABLE = "__UB_PORTABLE__" === "true";

  // relayOrigin normalizes a URL to its origin, rejecting credentials,
  // non-http(s) schemes, and unparseable input (returns null).
  function relayOrigin(relayUrl) {
    try {
      const u = new URL(relayUrl);
      if (u.username || u.password) return null;
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.origin;
    } catch (_) {
      return null;
    }
  }

  // isAllowedRelay returns true when relayUrl is authorised: its origin either
  // exactly matches an allowed entry (scheme + host + port), or — in a portable
  // build — the caller reports that origin as one the user granted
  // (opts.grantedOrigins, taken from chrome.permissions by the service worker).
  // opts may override both, which keeps the decision unit-testable.
  function isAllowedRelay(relayUrl, opts) {
    const origin = relayOrigin(relayUrl);
    if (origin === null) return false;
    if (ALLOWED_RELAY_ORIGINS.indexOf(origin) !== -1) return true;
    const o = opts || {};
    const portable = typeof o.portable === "boolean" ? o.portable : PORTABLE;
    if (!portable) return false;
    const granted = o.grantedOrigins || [];
    return granted.indexOf(origin) !== -1;
  }

  return {
    ALLOWED_RELAY_ORIGINS: ALLOWED_RELAY_ORIGINS,
    PORTABLE: PORTABLE,
    relayOrigin: relayOrigin,
    isAllowedRelay: isAllowedRelay,
  };
});
