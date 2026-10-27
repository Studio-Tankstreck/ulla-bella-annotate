// Ulla-Bella Extension — service worker. Owns the only network access to the
// Relay, so the content script never needs page-origin CORS. The paired Site
// {deviceId, siteId, origin, relayUrl, displayName, deviceCredential} lives in
// chrome.storage.local; the device credential never leaves that store.
//
// Job monitoring is persistent: each in-flight job's record — {jobId, status,
// startedAt, lastChecked, tabId, sessionKey, siteId, relayUrl, credential} — is
// stored under "jobs", and a chrome.alarms tick (plus a resume on every worker
// start) re-attaches to any non-terminal job. The relay/credential/session are
// SNAPSHOTTED at submit time, so a later re-pairing or setting change cannot
// re-route a round that was already sent, nor deliver its result into another
// session. A transient network error pauses active polling instead of failing
// the job, so a long Hermes edit outlives both a worker restart and a network blip.
importScripts("i18n-messages.js", "i18n.js", "lib.js", "pair.js", "relay-policy.js", "icons.js", "monitor.js", "session.js", "session-writer.js", "connections.js");

const ub = globalThis.UllaBella;
const pair = globalThis.UllaBellaPair;
const policy = globalThis.UllaBellaRelayPolicy;
const icons = globalThis.UllaBellaIcons;
const monitor = globalThis.UllaBellaMonitor;
const sessionMod = globalThis.UllaBellaSession;
const conns = globalThis.UllaBellaConnections;
const i18n = globalThis.UllaBellaI18n;

const STORE_KEY = "site"; // legacy single pairing (migrated into connections)
const JOBS_KEY = "jobs";
const CONTENT_SCRIPT_ID = "ullabella-annotate";
const MONITOR_ALARM = "ullabella-monitor";

// --- the single session writer ---------------------------------------------
//
// Every session write in the whole extension goes through this one queue, per
// session key (see src/session-writer.js). It is what makes a read-merge-write
// atomic with respect to other tabs: content scripts never write a session
// document themselves, they ask the worker (message "writeSession"). A worker
// restart loses no state — the queue is empty again and all state is in
// chrome.storage.local.
const sessionWriter = globalThis.UllaBellaSessionWriter.createWriter({
  session: sessionMod,
  read: async function (key) {
    const data = await chrome.storage.local.get(key);
    return data && data[key];
  },
  write: async function (key, session, extra) {
    const payload = {};
    payload[key] = session;
    if (extra && extra.migrate) {
      // Mark the legacy import in the SAME set call, so the import can never be
      // repeated (a repeat would resurrect removed annotations).
      const data = await chrome.storage.local.get(sessionMod.MIGRATED_KEY);
      const migrated = Object.assign({}, (data && data[sessionMod.MIGRATED_KEY]) || {});
      migrated[key] = Date.now();
      payload[sessionMod.MIGRATED_KEY] = migrated;
    }
    await chrome.storage.local.set(payload);
  },
});

// Toolbar icon states: grey = this page is not editable; active (green) = the content
// script is running on this tab (i.e. the paired Site with host permission).
// The icon is driven by the content script's own "ubActive" signal, not by
// reading tab URLs from the background.
const ICON_GREY = {
  16: "icons/icon16.png",
  32: "icons/icon32.png",
  48: "icons/icon48.png",
  128: "icons/icon128.png",
};
const ICON_ACTIVE = {
  16: "icons/icon16-active.png",
  32: "icons/icon32-active.png",
  48: "icons/icon48-active.png",
  128: "icons/icon128-active.png",
};

// Preload the icon PNGs into ImageData once, then set the toolbar icon via
// imageData. This avoids chrome.action.setIcon's path-based resource loader,
// which rejects the runtime-only -active icon files ("Could not load action
// icon") even though they are valid, present PNGs. Falls back to the path-based
// call if imageData loading ever fails.
let iconDataPromise = null;
function getIconData() {
  if (!iconDataPromise) {
    iconDataPromise = Promise.all([icons.loadGrey(), icons.loadActive()])
      .then(function (results) { return { grey: results[0], active: results[1] }; })
      .catch(function () { return null; });
  }
  return iconDataPromise;
}

async function setTabIcon(tabId, active) {
  const data = await getIconData();
  if (data) {
    try {
      await chrome.action.setIcon({ tabId: tabId, imageData: active ? data.active : data.grey });
      return;
    } catch (_) {
      // fall through to the path-based call below
    }
  }
  try {
    await chrome.action.setIcon({ tabId: tabId, path: active ? ICON_ACTIVE : ICON_GREY });
  } catch (_) {}
}

// --- job persistence (survives a MV3 worker restart) ------------------------

async function getJobs() {
  const data = await chrome.storage.local.get(JOBS_KEY);
  return (data && data[JOBS_KEY]) || {};
}

async function saveJobs(jobs) {
  await chrome.storage.local.set({ [JOBS_KEY]: jobs });
}

// --- serialized read-modify-write -------------------------------------------
//
// The connection set and the job list are each ONE storage map, so every change
// is a read-modify-write: two handlers can read the same snapshot and the one
// that writes last erases the other's change (two agent picks for two sites, an
// import racing a disconnect, two rounds starting at once). Running the handlers
// in the same service worker does not help — their awaits overlap. This single
// queue makes each read → change → write atomic with respect to the others.
//
// The queue holds nothing that matters: all state lives in chrome.storage.local,
// so a worker restart simply starts with an empty queue, and a mutation killed
// mid-flight either wrote (the change stands) or did not (the caller sees the
// old state and can retry).
let writeTail = Promise.resolve();

function serializeWrite(work) {
  const run = writeTail.then(work, work);
  writeTail = run.then(
    function () {},
    function () {}
  );
  return run;
}

function mutateJobs(change) {
  return serializeWrite(async function () {
    const data = await chrome.storage.local.get(JOBS_KEY);
    const jobs = (data && data[JOBS_KEY]) || {};
    const out = (await change(jobs)) || {};
    if (out.write) await chrome.storage.local.set({ [JOBS_KEY]: jobs });
    return out.value;
  });
}

async function upsertJob(job) {
  return mutateJobs(function (jobs) {
    jobs[job.jobId] = Object.assign({}, jobs[job.jobId], job);
    return { write: true };
  });
}

async function removeJob(jobId) {
  const left = await mutateJobs(function (jobs) {
    if (!jobs[jobId]) return { value: -1 };
    delete jobs[jobId];
    return { write: true, value: Object.keys(jobs).length };
  });
  if (left === 0) await clearMonitorAlarm();
}

// --- UI language -------------------------------------------------------------
//
// The toolbar tooltip is the only translated surface the worker owns. It follows
// the same stored choice the popup and the content script read, so a manual
// language is consistent across all of them. The read is memoized; a change
// arrives through the setLanguage message below.
let languageReady = null;

function ensureLanguage() {
  if (!languageReady) {
    languageReady = i18n.loadChoice(chrome.storage.local).catch(function () {});
  }
  return languageReady;
}

// setLanguage is the ONE write path for the language choice: it runs inside the
// same single-writer queue as every other settings change, so it can never be
// interleaved with (and lost to) a concurrent settings write.
async function setLanguage(choice) {
  const value = i18n.normalizeChoice(choice);
  await serializeWrite(async function () {
    await chrome.storage.local.set({ [i18n.LANG_KEY]: value });
  });
  languageReady = Promise.resolve(i18n.setLanguage(value));
  return { ok: true, language: i18n.language() };
}

ensureLanguage();

// --- toolbar badge (global — visible on every tab) ---------------------------

function setBadge(status) {
  const text = monitor.badgeFor(status);
  chrome.action.setBadgeText({ text: text }).catch(function () {});
  if (text) {
    chrome.action.setBadgeBackgroundColor({ color: "#55ac5f" }).catch(function () {});
  }
  // Set once right away (English until the stored choice is loaded) and again
  // when it is known, so a worker start never leaves a wrong-language tooltip.
  chrome.action.setTitle({ title: monitor.titleFor(status, i18n.t) }).catch(function () {});
  ensureLanguage().then(function () {
    chrome.action.setTitle({ title: monitor.titleFor(status, i18n.t) }).catch(function () {});
  });
}

// --- chrome.alarms recovery -------------------------------------------------

async function ensureMonitorAlarm() {
  const existing = await chrome.alarms.get(MONITOR_ALARM);
  if (!existing) {
    chrome.alarms.create(MONITOR_ALARM, { periodInMinutes: 1 });
  }
}

async function clearMonitorAlarm() {
  await chrome.alarms.clear(MONITOR_ALARM);
}

// --- monitoring (single-flight per job) --------------------------------------

const inFlight = new Set();

// ctx = { relayUrl, authHeaders, jobId, tabId, startedAt, sessionKey }
async function monitorJob(ctx) {
  if (inFlight.has(ctx.jobId)) return; // already monitoring this job
  inFlight.add(ctx.jobId);
  try {
    await pollLoop(ctx);
  } finally {
    inFlight.delete(ctx.jobId);
  }
}

function statusMessage(ctx, fields) {
  return Object.assign({ type: "ubJobStatus", jobId: ctx.jobId, sessionKey: ctx.sessionKey }, fields);
}

async function pollLoop(ctx) {
  const jobId = ctx.jobId;
  let lastHeartbeat = 0;
  let lastActivitySig = null;
  for (;;) {
    const r = await monitor.pollOnce(fetch, ctx.relayUrl, ctx.authHeaders, jobId);
    if (r.transient) {
      // A transient network error is NOT a job failure: the job keeps running
      // server-side. Persist the paused state, stop active polling, and let the
      // alarm (or a page reload) resume it.
      await upsertJob({ jobId: jobId, status: "paused", lastChecked: Date.now() });
      setBadge("paused");
      notifyStatus(ctx.tabId, statusMessage(ctx, { status: "paused" }));
      return;
    }

    const status = r.status;
    const now = Date.now();
    await upsertJob({ jobId: jobId, status: status, lastChecked: now });

    // Forward a real agent-activity snapshot the moment it changes, so the
    // panel updates promptly; the 5s heartbeat below keeps the "last checked"
    // ticker fresh in between.
    const activity = r.payload && r.payload.activity;
    const activitySig = activity ? activity.kind + "|" + activity.activityAt + "|" + activity.checkedAt : "";
    if (activitySig && activitySig !== lastActivitySig) {
      lastActivitySig = activitySig;
      notifyStatus(ctx.tabId, statusMessage(ctx, {
        status: status,
        activity: activity,
        lastChecked: now,
      }));
    }

    if (monitor.isTerminal(status)) {
      setBadge(status);
      notifyStatus(ctx.tabId, statusMessage(ctx, {
        status: status,
        summary: r.payload.summary,
        verification: r.payload.verification,
        annotationResults: r.payload.annotationResults,
        error: r.payload.error,
      }));
      await removeJob(jobId);
      return;
    }

    // Heartbeat so the panel's "last checked" stays fresh. "Last agent activity"
    // is only ever what the Relay reports (accepted → working → terminal) — the
    // extension never invents intermediate agent activity.
    if (now - lastHeartbeat >= monitor.HEARTBEAT_INTERVAL_MS) {
      lastHeartbeat = now;
      notifyStatus(ctx.tabId, statusMessage(ctx, {
        status: status,
        startedAt: ctx.startedAt,
        activity: activity,
        lastChecked: now,
      }));
    }

    await new Promise(function (resolve) { setTimeout(resolve, monitor.POLL_INTERVAL_MS); });
  }
}

// connectionForRecord returns the connection a stored job was submitted
// through — by its EXACT connectionId. Older records that predate the snapshot
// are completed from it; if that connection is gone the record stays
// unreachable instead of being re-pointed at another relay that happens to host
// the same siteId.
async function connectionForRecord(record) {
  if (!record || !record.connectionId) return null;
  const state = await loadConnections();
  return state.connections[record.connectionId] || null;
}

// jobContext builds the polling context for a stored job. The snapshot taken at
// submit time ALWAYS wins (relay, credential, session, agent), so changing a
// setting later can never re-route an accepted job or deliver its result into
// another session. `conn` only fills gaps an old record left empty.
function jobContext(record, conn) {
  return {
    relayUrl: record.relayUrl || (conn && conn.relayUrl) || "",
    authHeaders: {
      Authorization: "Bearer " + (record.deviceCredential || (conn && conn.deviceCredential) || ""),
    },
    jobId: record.jobId,
    tabId: record.tabId,
    startedAt: record.startedAt,
    sessionKey: record.sessionKey,
    connectionId: record.connectionId || (conn && conn.connectionId) || "",
    agentId: record.agentId || "",
  };
}

// orphanJob reports a round whose receiver cannot be identified any more. It is
// deliberately NOT re-routed: the user is told that the result cannot be
// collected, and the record stops being polled.
async function orphanJob(record, code) {
  const message =
    "The result of this round cannot be collected: the connection it was sent through is gone.";
  await upsertJob({
    jobId: record.jobId,
    status: "error",
    orphanedAt: Date.now(),
    error: { code: code, message: message },
  });
  notifyStatus(record.tabId, {
    type: "ubJobStatus",
    jobId: record.jobId,
    sessionKey: record.sessionKey,
    status: "error",
    error: { code: code, message: message },
  });
}

// resolveJobConnection decides the ONE connection a job may be sent through.
// An explicit connectionId is honoured exactly or the job fails BEFORE any
// network call: a round must never travel to another Relay that happens to
// serve the same siteId. A message without connectionId (older content script)
// is accepted only when exactly one connection matches the job's siteId.
async function resolveJobConnection(job, connectionId) {
  const state = await loadConnections();
  if (connectionId) {
    const explicit = state.connections[connectionId];
    if (!explicit) {
      return {
        error: {
          code: "connection_not_found",
          message: "This site is no longer connected. Reload the page and start again.",
        },
      };
    }
    return matchJobConnection(explicit, job);
  }
  const siteId = job && job.siteId;
  const matches = Object.keys(state.connections).filter(function (id) {
    return state.connections[id].siteId === siteId;
  });
  if (matches.length === 0) {
    return { error: { code: "site_not_configured", message: "No website is connected." } };
  }
  if (matches.length > 1) {
    return {
      error: {
        code: "ambiguous_connection",
        message: "This site is connected more than once. Reload the page so the round can be tied to one connection.",
      },
    };
  }
  return matchJobConnection(state.connections[matches[0]], job);
}

function matchJobConnection(conn, job) {
  if (job && job.siteId && job.siteId !== conn.siteId) {
    return {
      error: {
        code: "site_mismatch",
        message: "This round belongs to another site than the connection it was sent through.",
      },
    };
  }
  if (job && job.deviceId && job.deviceId !== conn.deviceId) {
    return {
      error: {
        code: "device_mismatch",
        message: "This round belongs to another connection than the one it was sent through.",
      },
    };
  }
  return { connection: conn };
}

// resumeActiveJobs re-attaches to every persisted non-terminal job. Called on
// worker start and on each alarm tick, so a worker restart never loses a job —
// and it polls each job against ITS OWN relay/credential/session.
async function resumeActiveJobs() {
  const jobs = await getJobs();
  const ids = Object.keys(jobs);
  if (ids.length === 0) return;
  await ensureMonitorAlarm();
  for (const jobId of ids) {
    const j = jobs[jobId];
    if (monitor.isTerminal(j.status)) continue;
    if (j.orphanedAt) continue;
    const conn = await connectionForRecord(j);
    const ctx = jobContext(j, conn);
    if (!ctx.relayUrl || !ctx.authHeaders.Authorization.replace("Bearer ", "")) {
      // Never switch receivers: report it and stop polling this record.
      await orphanJob(j, "connection_not_found");
      continue;
    }
    monitorJob(ctx).catch(function () {});
  }
}

// --- message handlers --------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "submitJob") {
    const tabId = sender && sender.tab && sender.tab.id;
    submitJob(msg.job, tabId, msg.sessionKey, msg.connectionId).then(
      (outcome) => sendResponse(outcome),
      (err) =>
        sendResponse({
          ok: false,
          error: {
            code: "relay_unreachable",
            message: err && err.message ? err.message : String(err),
          },
        })
    );
    return true; // async sendResponse
  }
  if (msg.type === "resumePoll") {
    const tabId = sender && sender.tab && sender.tab.id;
    resumePoll(msg.jobId, tabId, msg.sessionKey, msg.connectionId).then(
      (outcome) => sendResponse(outcome),
      (err) =>
        sendResponse({
          ok: false,
          error: {
            code: "relay_unreachable",
            message: err && err.message ? err.message : String(err),
          },
        })
    );
    return true;
  }
  if (msg.type === "getConnections") {
    listConnections().then((state) => sendResponse(state));
    return true;
  }
  if (msg.type === "setLanguage") {
    setLanguage(msg.language).then(
      (outcome) => sendResponse(outcome),
      (err) =>
        sendResponse({
          ok: false,
          error: { code: "settings_failed", message: String(err && err.message) },
        })
    );
    return true;
  }
  if (msg.type === "setActiveConnection") {
    setActiveConnection(msg.origin, msg.connectionId).then(
      (state) => sendResponse({ ok: true, state }),
      (err) => sendResponse({ ok: false, error: { code: "settings_failed", message: String(err && err.message) } })
    );
    return true;
  }
  if (msg.type === "setAgent") {
    setAgent(msg.connectionId, msg.agentId, msg.agentName).then(
      (state) => sendResponse({ ok: true, state }),
      (err) => sendResponse({ ok: false, error: { code: "settings_failed", message: String(err && err.message) } })
    );
    return true;
  }
  if (msg.type === "listAgents") {
    listAgents(msg.connectionId).then(
      (outcome) => sendResponse(outcome),
      (err) =>
        sendResponse({
          ok: false,
          error: { code: "relay_unreachable", message: err && err.message ? err.message : String(err) },
        })
    );
    return true;
  }
  if (msg.type === "disconnect") {
    disconnectConnection(msg.connectionId).then(
      (state) => sendResponse({ ok: true, state }),
      (err) => sendResponse({ ok: false, error: { code: "disconnect_failed", message: String(err && err.message) } })
    );
    return true;
  }
  // The ONE write path for session documents. Serialized per session key inside
  // this worker, merged against what is stored at the moment of writing, and
  // answered with the document that is actually stored afterwards.
  if (msg.type === "writeSession") {
    sessionWriter
      .submit(msg.sessionKey, msg.session, msg.migrate ? { migrate: true } : null)
      .then((outcome) =>
        sendResponse({ ok: true, session: outcome.session, written: outcome.write, reason: outcome.reason })
      )
      .catch((err) =>
        sendResponse({
          ok: false,
          error: {
            code: "session_write_failed",
            message: err && err.message ? err.message : String(err),
          },
        })
      );
    return true;
  }
  if (msg.type === "redeemInvite") {
    redeemAndStore(msg.relayUrl, msg.invite).then(
      (connection) => sendResponse({ ok: true, site: connection, connection }),
      (err) =>
        sendResponse({
          ok: false,
          error: {
            code: err && err.code ? err.code : "relay_unreachable",
            message: err && err.message ? err.message : String(err),
          },
        })
    );
    return true;
  }
  if (msg.type === "registerSite") {
    ensureSiteReady()
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: {
            code: "permission_denied",
            message: err && err.message ? err.message : String(err),
          },
        })
      );
    return true;
  }
  // The content script announces itself once injected on the paired Site; the
  // toolbar icon turns active (green) for that tab.
  if (msg.type === "ubActive") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId != null) {
      setTabIcon(tabId, true);
    }
  }
  // The popup syncs the icon when it opens (it reliably knows the active tab's
  // state via activeTab).
  if (msg.type === "syncIcon") {
    setTabIcon(msg.tabId, !!msg.active);
  }
});

// --- connections ------------------------------------------------------------

// loadConnections reads the connection set and applies the (pure, idempotent)
// migration from the pre-etapp-3 single `site` record. Every read path goes
// through it, so a worker restart or two racing contexts converge on the same
// ids.
const CONNECTION_KEYS = [
  conns.STORE_KEY,
  conns.ACTIVE_KEY,
  conns.REMOVED_KEY,
  conns.LEGACY_SITE_KEY,
  conns.MIGRATED_KEY,
];

// mutateConnections is the ONLY writer of the connection set. It reads inside
// the queue, applies the (pure, idempotent) migration, lets `change` compute a
// patch from that fresh snapshot, and writes both together — so an old snapshot
// can never overwrite a newer change and a migration can never undo one.
function mutateConnections(change) {
  return serializeWrite(async function () {
    const data = await chrome.storage.local.get(CONNECTION_KEYS);
    const state = conns.migrate(data);
    state.raw = data;
    const patch = {};
    if (state.changed) {
      patch[conns.STORE_KEY] = state.connections;
      patch[conns.ACTIVE_KEY] = state.activeByOrigin;
    }
    if (state.needsMarker) patch[conns.MIGRATED_KEY] = { at: Date.now(), version: 1 };
    const out = (await change(state)) || {};
    Object.assign(patch, out.patch || {});
    if (Object.keys(patch).length > 0) await chrome.storage.local.set(patch);
    return out.value === undefined ? state : out.value;
  });
}

// loadConnections is the read path: it returns the migrated view and persists
// the migration if one was due (through the same queue, so it cannot clobber a
// concurrent change).
async function loadConnections() {
  return mutateConnections(async function () {
    return {};
  });
}

// listConnections is what the popup renders: connections, per-origin choices and
// whether the Relay label is needed to tell them apart.
async function listConnections() {
  const state = await loadConnections();
  return {
    connections: state.connections,
    activeByOrigin: state.activeByOrigin,
    needsRelayLabel: conns.needsRelayLabel(state.connections),
  };
}

async function setActiveConnection(origin, connectionId) {
  if (!origin) throw new Error("origin is required");
  await mutateConnections(async function (state) {
    const target = connectionId ? state.connections[connectionId] : null;
    if (connectionId && !target) throw new Error("unknown connection");
    if (target && !conns.sameOrigin(target.origin, origin)) {
      throw new Error("connection does not serve this origin");
    }
    const patch = {};
    patch[conns.ACTIVE_KEY] = conns.setActive(state.activeByOrigin, origin, connectionId || "");
    return { patch: patch };
  });
  return listConnections();
}

// setAgent stores the user's choice. The Relay re-validates it on every job
// (agent_sites), so this is a preference, not an authorization.
async function setAgent(connectionId, agentId, agentName) {
  await mutateConnections(async function (state) {
    if (!state.connections[connectionId]) throw new Error("unknown connection");
    const patch = {};
    patch[conns.STORE_KEY] = conns.withAgent(state.connections, connectionId, agentId, agentName);
    return { patch: patch };
  });
  return listConnections();
}

// disconnectConnection removes ONE connection: its credential and this browser's
// authorization for that site. Local sessions are deliberately NOT deleted —
// clearing a session is a separate action in the editor — and other connections
// are untouched.
async function disconnectConnection(connectionId) {
  let origin = null;
  await mutateConnections(async function (state) {
    const target = state.connections[connectionId];
    if (!target) throw new Error("unknown connection");
    origin = target.origin;
    const next = conns.without(state.connections, state.activeByOrigin, connectionId);
    const removed = Object.assign({}, (state.raw && state.raw[conns.REMOVED_KEY]) || {});
    removed[connectionId] = Date.now();
    const patch = {};
    patch[conns.STORE_KEY] = next.connections;
    patch[conns.ACTIVE_KEY] = next.activeByOrigin;
    patch[conns.REMOVED_KEY] = removed;
    return { patch: patch };
  });

  // Only drop the host permission when no remaining connection needs it.
  const after = await loadConnections();
  const stillUsed = Object.keys(after.connections).some(function (id) {
    return conns.sameOrigin(after.connections[id].origin, origin);
  });
  if (!stillUsed) {
    try {
      await chrome.permissions.remove({ origins: [origin + "/*"] });
    } catch (_) {
      // best-effort: the content script also self-gates on the stored origin
    }
  }
  await ensureSiteReady();
  return listConnections();
}

// listAgents asks the Relay which agents this browser may use for this site. It
// is the ONLY source for the agent picker: agents the site is not granted never
// appear, and the answer is scoped to this device's credential.
async function listAgents(connectionId) {
  const state = await loadConnections();
  const c = state.connections[connectionId];
  if (!c) return { ok: false, error: { code: "unknown_connection", message: "This connection is gone." } };
  let resp;
  try {
    resp = await fetch(
      c.relayUrl + "/v1/sites/" + encodeURIComponent(c.siteId) + "/agents",
      { headers: { Authorization: "Bearer " + c.deviceCredential } }
    );
  } catch (_) {
    return { ok: false, error: { code: "relay_unreachable", message: "Could not reach the Relay." } };
  }
  let body = null;
  try {
    body = await resp.json();
  } catch (_) {
    body = null;
  }
  if (!resp.ok) {
    const err = (body && body.error) || {};
    return {
      ok: false,
      error: {
        code: err.code || "relay_error",
        message: err.message || "The Relay could not list agents.",
      },
    };
  }
  const agents = (body && Array.isArray(body.agents) ? body.agents : []).map(function (a) {
    return { agentId: String(a.agentId || ""), name: String(a.name || a.agentId || ""), connected: !!a.connected };
  });
  return { ok: true, agents: agents, checkedAt: new Date().toISOString() };
}

// relayAuthorised decides whether this build may talk to relayUrl. A canonical
// build allows exactly the packaged origin. A portable build bakes no origin in:
// there the origin is accepted only while this extension holds the host
// permission the user granted for it when importing their .ullabella file, so a
// file alone can never widen the extension's network access.
async function relayAuthorised(relayUrl) {
  if (policy.isAllowedRelay(relayUrl)) return true;
  if (policy.PORTABLE !== true) return false;
  const origin = policy.relayOrigin(relayUrl);
  if (!origin) return false;
  let granted = false;
  try {
    granted = (await chrome.permissions.contains({ origins: [origin + "/*"] })) === true;
  } catch (_) {
    granted = false;
  }
  return policy.isAllowedRelay(relayUrl, { portable: true, grantedOrigins: granted ? [origin] : [] });
}

// redeemAndStore verifies the imported relayUrl is an allowed Relay origin,
// redeems the invite, and ADDS the connection (it never replaces the others).
async function redeemAndStore(relayUrl, invite) {
  if (!(await relayAuthorised(relayUrl))) {
    throw pairError("relay_not_allowed", "This file points to an unrecognized Ulla-Bella service.");
  }
  const config = await pair.redeemInvite(relayUrl, invite);
  const connection = conns.normalizeConnection({
    deviceId: config.deviceId,
    siteId: config.siteId,
    origin: config.origin,
    relayUrl: relayUrl,
    displayName: config.displayName || config.origin,
    deviceCredential: config.deviceCredential,
    createdAt: new Date().toISOString(),
  });
  await mutateConnections(async function (state) {
    const next = conns.upsert(state.connections, connection);
    const active = state.activeByOrigin[connection.origin]
      ? state.activeByOrigin
      : conns.setActive(state.activeByOrigin, connection.origin, connection.connectionId);
    const patch = {};
    patch[conns.STORE_KEY] = next;
    patch[conns.ACTIVE_KEY] = active;
    patch[conns.MIGRATED_KEY] = { at: Date.now(), version: 1 };
    return { patch: patch };
  });
  return connection;
}

function pairError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// registerContentScript registers ONE dynamic content script covering every
// origin this extension holds a permission for. Registering the whole list (and
// unregistering when it is empty) keeps add/remove of sites consistent.
async function registerContentScript(origins) {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  if (origins.length === 0) {
    if (existing && existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    }
    return;
  }
  const script = {
    id: CONTENT_SCRIPT_ID,
    matches: origins.map(function (origin) {
      return origin + "/*";
    }),
    js: ["src/i18n-messages.js", "src/i18n.js", "src/lib.js", "src/queue.js", "src/session.js", "src/connections.js", "src/content.js"],
    css: ["src/annotate.css"],
    runAt: "document_idle",
    persistAcrossSessions: true,
  };
  if (existing && existing.length > 0) {
    await chrome.scripting.updateContentScripts([script]);
  } else {
    await chrome.scripting.registerContentScripts([script]);
  }
}

// injectIntoActiveTab immediately injects the annotation content script into the
// active tab when it belongs to one of the connections, so the user can start
// editing without reloading the page. (A dynamically registered content script
// only runs on the NEXT navigation, not the already-open page.)
async function injectIntoActiveTab(origins) {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || tab.id == null || !tab.url) return;
  let tabOrigin = null;
  try {
    tabOrigin = new URL(tab.url).origin;
  } catch (_) {
    return;
  }
  if (origins.indexOf(tabOrigin) === -1) return;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/i18n-messages.js", "src/i18n.js", "src/lib.js", "src/queue.js", "src/session.js", "src/connections.js", "src/content.js"],
  });
  await chrome.scripting.insertCSS({
    target: { tabId: tab.id },
    files: ["src/annotate.css"],
  });
}

// ensureSiteReady re-registers the content scripts (and injects into the active
// tab) whenever the worker starts or the connection set changes, so every
// connected Site keeps working across extension reloads and browser restarts —
// dynamic registrations are not reliably persistent across those.
async function ensureSiteReady() {
  const state = await loadConnections();
  const origins = [];
  for (const id of Object.keys(state.connections)) {
    const origin = state.connections[id].origin;
    if (origins.indexOf(origin) !== -1) continue;
    let granted = false;
    try {
      granted = await chrome.permissions.contains({ origins: [origin + "/*"] });
    } catch (_) {
      granted = false;
    }
    if (granted) origins.push(origin);
  }
  try {
    await registerContentScript(origins);
    await injectIntoActiveTab(origins);
  } catch (_) {
    // best-effort; the next navigation or a re-grant will retry
  }
}

// --- job submit + resume -----------------------------------------------------

async function submitJob(job, tabId, sessionKey, connectionId) {
  const resolved = await resolveJobConnection(job, connectionId);
  if (resolved.error) return { ok: false, error: resolved.error };
  const stored = resolved.connection;
  const relayUrl = stored.relayUrl;
  const authHeaders = { Authorization: "Bearer " + stored.deviceCredential };
  const envelope = ub.buildEnvelope("job", job);
  const startedAt = Date.now();

  // Persist before the POST so a worker restart during submit never loses it.
  // This snapshot (connection, relay, credential, session, agent) pins the round:
  // later setting changes must not alter an accepted job's receiver, its resend
  // or its resumed monitoring.
  await upsertJob({
    jobId: job.jobId,
    siteId: job.siteId,
    connectionId: stored.connectionId,
    sessionKey: sessionKey,
    relayUrl: relayUrl,
    deviceCredential: stored.deviceCredential,
    agentId: job.agentId || stored.agentId || "",
    status: "submitting",
    startedAt: startedAt,
    tabId: tabId,
  });

  // The Relay may briefly report agent_unavailable while the adapter reconnects
  // (a ~1s keepalive gap). Retry a couple of times rather than failing the user.
  // A CHOSEN agent that is not available is NOT retried into another agent: the
  // Relay never falls back, and neither do we.
  let accepted = {};
  let resp;
  for (let attempt = 0; ; attempt++) {
    try {
      resp = await fetch(relayUrl + "/v1/jobs", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders),
        body: JSON.stringify(envelope),
      });
    } catch (_) {
      await removeJob(job.jobId);
      return {
        ok: false,
        error: { code: "relay_unreachable", message: "Could not reach the Relay." },
      };
    }
    try {
      accepted = await resp.json();
    } catch (_) {
      accepted = {};
    }
    if (resp.ok) break;
    const payload = accepted.payload || {};
    const code = payload.error && payload.error.code;
    if (code === "agent_unavailable" && !job.agentId && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    await removeJob(job.jobId);
    const error = payload.error || {
      code: "relay_error",
      message: "The Relay rejected the job.",
    };
    return { ok: false, error: error };
  }

  const ctx = {
    relayUrl: relayUrl,
    authHeaders: authHeaders,
    jobId: job.jobId,
    tabId: tabId,
    startedAt: startedAt,
    sessionKey: sessionKey,
    connectionId: stored.connectionId,
    agentId: job.agentId || stored.agentId || "",
  };

  // An idempotent re-submit returns the existing result, which may already be
  // terminal (done/error). Deliver it immediately instead of polling.
  const posted = accepted.payload || {};
  if (monitor.isTerminal(posted.status)) {
    setBadge(posted.status);
    notifyStatus(tabId, statusMessage(ctx, {
      status: posted.status,
      summary: posted.summary,
      verification: posted.verification,
      annotationResults: posted.annotationResults,
      error: posted.error,
    }));
    await removeJob(job.jobId);
    return { ok: true };
  }

  const jobId = (accepted.payload && accepted.payload.jobId) || job.jobId;
  ctx.jobId = jobId;
  await upsertJob({ jobId: jobId, status: "working", startedAt: startedAt, tabId: tabId });
  setBadge("working");
  notifyStatus(tabId, statusMessage(ctx, { status: "working", startedAt: startedAt, lastChecked: Date.now() }));
  await ensureMonitorAlarm();
  // Start monitoring asynchronously; the terminal state arrives via ubJobStatus.
  monitorJob(ctx).catch(function () {});
  return { ok: true };
}

// resumePoll re-attaches to an already-accepted job (e.g. after a page reload
// or a worker restart) without re-submitting it. The Relay's jobId dedup makes
// this safe: a resume never starts a duplicate execution. The job's own snapshot
// decides which relay/credential/session it belongs to.
async function resumePoll(jobId, tabId, sessionKey, connectionId) {
  const jobs = await getJobs();
  const record = jobs[jobId];

  if (record) {
    if (monitor.isTerminal(record.status)) return { ok: true };
    // The stored snapshot decides the receiver. A connection that was
    // disconnected meanwhile does NOT move the poll to another connection: the
    // round keeps the relay and credential it was accepted on.
    const conn = await connectionForRecord(record);
    const ctx = jobContext(
      Object.assign({}, record, { tabId: tabId, sessionKey: record.sessionKey || sessionKey }),
      conn
    );
    if (!ctx.relayUrl || !ctx.authHeaders.Authorization.replace("Bearer ", "")) {
      await orphanJob(record, "connection_not_found");
      return {
        ok: false,
        error: {
          code: "connection_not_found",
          message: "This round cannot be resumed: the connection it was sent through is gone.",
        },
      };
    }
    await ensureMonitorAlarm();
    monitorJob(ctx).catch(function () {});
    return { ok: true };
  }

  // No record (purged or predating job storage). Only an EXPLICIT connection can
  // be pinned; guessing by siteId is exactly what must not happen.
  if (!connectionId) {
    return {
      ok: false,
      error: {
        code: "connection_not_found",
        message: "This round cannot be resumed without the connection it belongs to.",
      },
    };
  }
  const state = await loadConnections();
  const conn = state.connections[connectionId];
  if (!conn) {
    return {
      ok: false,
      error: {
        code: "connection_not_found",
        message: "This site is no longer connected. Reload the page and start again.",
      },
    };
  }
  const base = {
    jobId: jobId,
    status: "working",
    startedAt: Date.now(),
    tabId: tabId,
    sessionKey: sessionKey,
    connectionId: conn.connectionId,
    relayUrl: conn.relayUrl,
    deviceCredential: conn.deviceCredential,
    agentId: conn.agentId || "",
  };
  await upsertJob(base);
  const ctx = jobContext(base, conn);
  await ensureMonitorAlarm();
  monitorJob(ctx).catch(function () {});
  return { ok: true };
}

function notifyStatus(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(function () {});
}

// --- toolbar icon + lifecycle (driven by the content script's presence) ------

chrome.tabs.onActivated.addListener(() => {
  // Re-inject into the newly-active tab when it is the paired Site (the tab may
  // have been open since before the content script was registered).
  ensureSiteReady();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Any navigation unloads the content script; reset to grey. The content script
  // re-signals ubActive when it (re)loads on the paired Site.
  if (changeInfo.status === "loading") {
    setTabIcon(tabId, false);
  }
});

chrome.runtime.onInstalled.addListener(ensureSiteReady);
chrome.runtime.onStartup.addListener(() => {
  ensureSiteReady();
  resumeActiveJobs();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MONITOR_ALARM) {
    resumeActiveJobs();
  }
});

// Self-heal on every service-worker start (extension reload / browser restart):
// re-register + inject the content script, and resume any in-flight job.
ensureSiteReady();
resumeActiveJobs();
