// Ulla-Bella Extension — connections (pure, no DOM, no chrome.*).
//
// Etapp 3 turns the single paired Site into a set of CONNECTIONS. A connection is
// one browser authorization for one Site on one Relay:
//
//   connectionId = <relay origin>|<siteId>
//
// The Relay is part of the identity on purpose: two Relays may host the same
// siteId, and their credentials, sessions and jobs must never mix. Everything
// that is stored per connection (sessions, jobs, the chosen agent) is keyed by
// this id, never by siteId alone.
//
// UMD like lib.js/queue.js/session.js. `require()` in tests,
// `globalThis.UllaBellaConnections` in the extension.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.UllaBellaConnections = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STORE_KEY = "connections";
  const ACTIVE_KEY = "activeByOrigin";
  const REMOVED_KEY = "removedConnections";
  const LEGACY_SITE_KEY = "site";
  const MIGRATED_KEY = "ub.migrated.connections";

  function str(v) {
    return typeof v === "string" ? v : "";
  }

  function relayOrigin(relayUrl) {
    try {
      return new URL(String(relayUrl)).origin;
    } catch (_) {
      return String(relayUrl || "").replace(/\/+$/, "");
    }
  }

  // connectionId is deterministic, so a re-run of the migration produces the same
  // id and therefore the same sessions and jobs.
  function connectionId(relayUrl, siteId) {
    return relayOrigin(relayUrl) + "|" + str(siteId);
  }

  function sameOrigin(a, b) {
    try {
      const x = new URL(String(a));
      const y = new URL(String(b));
      return x.protocol === y.protocol && x.host === y.host;
    } catch (_) {
      return false;
    }
  }

  function normalizeConnection(raw) {
    if (!raw || typeof raw !== "object") return null;
    const siteId = str(raw.siteId);
    const relayUrl = str(raw.relayUrl);
    const origin = str(raw.origin);
    if (!siteId || !relayUrl || !origin) return null;
    return {
      connectionId: str(raw.connectionId) || connectionId(relayUrl, siteId),
      relayUrl: relayUrl,
      relayOrigin: relayOrigin(relayUrl),
      siteId: siteId,
      deviceId: str(raw.deviceId),
      origin: origin,
      displayName: str(raw.displayName) || origin,
      deviceCredential: str(raw.deviceCredential),
      // agentId is the Relay-side agent identity (which adapter, and therefore
      // which Hermes instance, performs the edit). Empty = not chosen yet.
      agentId: str(raw.agentId),
      agentName: str(raw.agentName),
      createdAt: str(raw.createdAt),
      updatedAt: str(raw.updatedAt),
      migratedFrom: str(raw.migratedFrom),
    };
  }

  function normalizeMap(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const key of Object.keys(raw)) {
      const c = normalizeConnection(raw[key]);
      if (c) out[c.connectionId] = c;
    }
    return out;
  }

  // fromLegacySite converts the pre-etapp-3 single `site` record.
  function fromLegacySite(site) {
    if (!site || typeof site !== "object") return null;
    const c = normalizeConnection({
      relayUrl: site.relayUrl,
      siteId: site.siteId,
      deviceId: site.deviceId,
      origin: site.origin,
      displayName: site.displayName,
      deviceCredential: site.deviceCredential,
      migratedFrom: "site",
      createdAt: site.createdAt,
    });
    return c;
  }

  // migrate is PURE and IDEMPOTENT: given a storage snapshot it returns the
  // connections, the per-origin choices, and whether anything has to be written
  // back. Running it twice (worker restart, two contexts racing) is safe because
  // the ids are deterministic and the legacy record is only imported until the
  // marker exists.
  function migrate(data) {
    const d = data || {};
    const connections = normalizeMap(d[STORE_KEY]);
    const removed = d[REMOVED_KEY] && typeof d[REMOVED_KEY] === "object" ? d[REMOVED_KEY] : {};
    const marker = d[MIGRATED_KEY] && typeof d[MIGRATED_KEY] === "object" ? d[MIGRATED_KEY] : null;
    let changed = false;

    // Legacy single pairing -> one connection. Never re-imported after the
    // marker exists, so a disconnected site is not resurrected.
    if (!marker && d[LEGACY_SITE_KEY]) {
      const legacy = fromLegacySite(d[LEGACY_SITE_KEY]);
      if (legacy && !removed[legacy.connectionId] && !connections[legacy.connectionId]) {
        connections[legacy.connectionId] = legacy;
        changed = true;
      }
    }
    // A connection the user disconnected stays gone, even if a stale record
    // still exists somewhere.
    for (const id of Object.keys(removed)) {
      if (connections[id]) {
        delete connections[id];
        changed = true;
      }
    }

    // Only a REAL user choice is kept. Never invent one: with two connections
    // for the same origin the page must stay uneditable until the user picks.
    const active = {};
    const stored = d[ACTIVE_KEY] && typeof d[ACTIVE_KEY] === "object" ? d[ACTIVE_KEY] : {};
    for (const id of Object.keys(connections)) {
      const origin = connections[id].origin;
      const chosen = stored[origin];
      if (chosen && connections[chosen] && sameOrigin(connections[chosen].origin, origin)) {
        active[origin] = chosen;
      }
    }
    for (const origin of Object.keys(stored)) {
      if (!active[origin]) changed = true;
    }

    // Only mark the migration once there is something to migrate. A brand-new
    // profile (no pairing yet) must NOT write the marker, or a later legacy
    // `site` record would never be imported.
    const markerMissing = !marker;
    const hasConnections = Object.keys(connections).length > 0;
    const needsMarker = markerMissing && hasConnections;
    if (needsMarker) changed = true;
    return {
      connections: connections,
      activeByOrigin: active,
      changed: changed,
      marker: marker || { at: null, version: 1 },
      needsMarker: needsMarker,
    };
  }

  // resolveForOrigin is how a TAB decides which connection its edits belong to.
  // It never guesses between two connections for the same origin: the user must
  // choose, and that choice is stored per origin (so it can never send another
  // tab's changes to a site it does not serve).
  function resolveForOrigin(connections, activeByOrigin, origin) {
    const map = connections || {};
    const matches = Object.keys(map)
      .filter(function (id) {
        return sameOrigin(map[id].origin, origin);
      })
      .sort();
    if (matches.length === 0) {
      return { connection: null, candidates: [], ambiguous: false, chosenBy: null };
    }
    if (matches.length === 1) {
      return { connection: map[matches[0]], candidates: matches, ambiguous: false, chosenBy: "only" };
    }
    const chosen = activeByOrigin && activeByOrigin[origin];
    if (chosen && matches.indexOf(chosen) !== -1) {
      return { connection: map[chosen], candidates: matches, ambiguous: false, chosenBy: "explicit" };
    }
    return { connection: null, candidates: matches, ambiguous: true, chosenBy: null };
  }

  function upsert(connections, connection) {
    const c = normalizeConnection(connection);
    const out = Object.assign({}, connections || {});
    if (!c) return out;
    const previous = out[c.connectionId] || {};
    out[c.connectionId] = Object.assign({}, previous, c, {
      createdAt: previous.createdAt || c.createdAt,
      updatedAt: c.updatedAt,
      // Re-pairing keeps a previously chosen agent unless the new record sets one.
      agentId: c.agentId || previous.agentId || "",
      agentName: c.agentName || previous.agentName || "",
    });
    return out;
  }

  function withAgent(connections, id, agentId, agentName) {
    const out = Object.assign({}, connections || {});
    const c = out[id];
    if (!c) return out;
    out[id] = Object.assign({}, c, { agentId: str(agentId), agentName: str(agentName) });
    return out;
  }

  function without(connections, activeByOrigin, id) {
    const conns = Object.assign({}, connections || {});
    delete conns[id];
    const active = {};
    for (const origin of Object.keys(activeByOrigin || {})) {
      if (activeByOrigin[origin] !== id) active[origin] = activeByOrigin[origin];
    }
    return { connections: conns, activeByOrigin: active };
  }

  function setActive(activeByOrigin, origin, id) {
    const active = Object.assign({}, activeByOrigin || {});
    if (id) active[origin] = id;
    else delete active[origin];
    return active;
  }

  // relaysBySiteId tells the UI when it has to show the Relay (same siteId on
  // two Relays, or the same origin paired twice).
  function needsRelayLabel(connections) {
    const bySite = {};
    for (const id of Object.keys(connections || {})) {
      const c = connections[id];
      bySite[c.siteId] = (bySite[c.siteId] || 0) + 1;
    }
    return Object.keys(bySite).some(function (sid) {
      return bySite[sid] > 1;
    });
  }

  // statusFromProbe maps a listAgents result to a UI state. "unavailable" (the
  // service could not be reached) and "unknown" (never checked) are deliberately
  // different states.
  function statusFromProbe(probe) {
    if (!probe) return "unknown";
    if (probe.ok) return "online";
    const code = probe.error && probe.error.code;
    switch (code) {
      case "relay_unreachable":
      case "timeout":
        return "unavailable";
      case "invalid_credential":
      case "device_out_of_scope":
      case "device_mismatch":
      case "site_disabled":
      case "site_not_found":
        return "unauthorized";
      default:
        return "unknown";
    }
  }

  // statusLabel names a probe state. `t` is the caller's translator (i18n.t): the
  // copy lives in the locale files, not here.
  function statusLabel(status, t) {
    switch (status) {
      case "online": return t("connStatusConnected");
      case "unavailable": return t("connStatusUnreachable");
      case "unauthorized": return t("connStatusUnauthorized");
      default: return t("connStatusUnknown");
    }
  }

  function relayHost(relayUrl) {
    try {
      return new URL(String(relayUrl)).host;
    } catch (_) {
      return String(relayUrl || "");
    }
  }

  // agentOptions normalizes the Relay's list for a <select>: the chosen agent is
  // always present, marked as no longer offered if the Relay stopped listing it.
  function agentOptions(agents, chosenAgentId, t) {
    const list = (agents || []).map(function (a) {
      return { agentId: str(a.agentId), name: str(a.name) || str(a.agentId), connected: !!a.connected };
    });
    const chosen = str(chosenAgentId);
    if (chosen && !list.some(function (a) { return a.agentId === chosen; })) {
      list.push({ agentId: chosen, name: t("agentNoLongerOffered", { name: chosen }), connected: false });
    }
    return list;
  }

  return {
    STORE_KEY: STORE_KEY,
    ACTIVE_KEY: ACTIVE_KEY,
    REMOVED_KEY: REMOVED_KEY,
    LEGACY_SITE_KEY: LEGACY_SITE_KEY,
    MIGRATED_KEY: MIGRATED_KEY,
    relayOrigin: relayOrigin,
    connectionId: connectionId,
    sameOrigin: sameOrigin,
    normalizeConnection: normalizeConnection,
    normalizeMap: normalizeMap,
    fromLegacySite: fromLegacySite,
    migrate: migrate,
    resolveForOrigin: resolveForOrigin,
    upsert: upsert,
    withAgent: withAgent,
    without: without,
    setActive: setActive,
    needsRelayLabel: needsRelayLabel,
    statusFromProbe: statusFromProbe,
    statusLabel: statusLabel,
    relayHost: relayHost,
    agentOptions: agentOptions,
  };
});
