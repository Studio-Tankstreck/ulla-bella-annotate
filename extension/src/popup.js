"use strict";

// Ulla-Bella Extension — popup.
//
// Two things live here (sessions etapp 3):
//   1. the CURRENT PAGE: which connected site this tab belongs to and which
//      Hermes agent will receive its changes, right next to "Start editing";
//   2. SETTINGS: every connection, its agent (from the Relay's authorization-
//      checked list), a verified status, and disconnect.
//
// The popup owns no network access: the service worker talks to the Relay. No
// developer terminology (siteId, relay URL, credentials) is shown unless it is
// the only way to tell two connections apart.

const pair = globalThis.UllaBellaPair;
const ub = globalThis.UllaBella;
const conns = globalThis.UllaBellaConnections;
const policy = globalThis.UllaBellaRelayPolicy;
const i18n = globalThis.UllaBellaI18n;

const el = (id) => document.getElementById(id);

let state = { connections: {}, activeByOrigin: {}, needsRelayLabel: false };
// The stored language choice ("auto" or a supported code). Kept apart from
// `state`, which every settings response replaces wholesale.
let languageChoice = "auto";
let probes = {};          // connectionId -> { status, agents }
let activeTab = null;
let activeOrigin = null;
let armingDisconnect = null; // connectionId armed for a second click

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => resolve(resp || { ok: false }));
    } catch (_) {
      resolve({ ok: false });
    }
  });
}

async function loadState() {
  const next = await send({ type: "getConnections" });
  if (next && next.connections) state = next;
  return state;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return (tabs && tabs[0]) || null;
}

async function hasSitePermission(origin) {
  try {
    return !!(await chrome.permissions.contains({ origins: [origin + "/*"] }));
  } catch (_) {
    return false;
  }
}

function showError(message) {
  const e = el("error");
  if (!message) {
    e.hidden = true;
    e.textContent = "";
    return;
  }
  e.textContent = message;
  e.hidden = false;
}

function friendlyPairError(err) {
  const e = err || {};
  switch (e.code) {
    case "invalid_file":
    case "invalid_format":
    case "unsupported_version":
    case "invalid_relay_url":
    case "invalid_invite":
      return i18n.t("errInvalidFile");
    case "relay_not_allowed":
      return i18n.t("errRelayNotAllowed");
    case "invite_not_found":
      return i18n.t("errInviteNotFound");
    case "invite_expired":
      return i18n.t("errInviteExpired");
    case "invite_already_used":
      return i18n.t("errInviteUsed");
    case "site_not_found":
    case "site_disabled":
      return i18n.t("errSiteUnavailable");
    case "relay_unreachable":
    case "relay_error":
      return i18n.t("errCannotReach");
    case "invalid_pair_response":
      return i18n.t("errPairFailed");
    case "permission_denied":
      return i18n.t("errPermissionDenied");
    default:
      // An unmapped code is a diagnosis, not copy: show a translated sentence
      // rather than surfacing a service's free text in an unknown language.
      return i18n.t("errConnectFailed");
  }
}

// --- language ---------------------------------------------------------------

// applyStaticCopy writes every element that carries data-i18n, so the markup
// keeps readable English as its pre-script fallback while the locale files stay
// the single source of the wording.
function applyStaticCopy() {
  document.documentElement.lang = i18n.language();
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = i18n.t(node.getAttribute("data-i18n"));
  }
  const note = el("disconnect-note");
  if (note) note.textContent = i18n.t("popupDisconnectNote", { clear: i18n.t("panelClearSession") });
}

// renderLanguage lists "Automatic" (naming the language the browser would give
// us) followed by every supported language written in its own language, so a
// user who cannot read the current interface can still find their own.
function renderLanguage() {
  const select = el("language-choice");
  if (!select) return;
  select.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = i18n.AUTO;
  auto.textContent = i18n.t("settingsLanguageAuto", {
    language: i18n.languageLabel(i18n.resolveLanguage(i18n.AUTO, i18n.uiLanguage())),
  });
  select.appendChild(auto);
  for (const lang of i18n.LANGUAGES) {
    const opt = document.createElement("option");
    opt.value = lang.code;
    opt.textContent = lang.label;
    select.appendChild(opt);
  }
  select.value = i18n.normalizeChoice(languageChoice);
}

// --- current page -----------------------------------------------------------

function connectionLabel(conn) {
  return conn.displayName || conn.origin;
}

function agentText(conn) {
  if (!conn) return "";
  if (conn.agentId) return i18n.t("agentChosen", { name: conn.agentName || conn.agentId });
  return i18n.t("agentNotChosen");
}

async function renderPage() {
  const siteEl = el("page-site");
  const agentEl = el("page-agent");
  const hintEl = el("page-hint");
  const choice = el("page-choice");
  const chooser = el("connection-choice");
  const grantBtn = el("grant-access");
  const startBtn = el("start-editing");

  grantBtn.hidden = true;
  startBtn.hidden = true;
  hintEl.hidden = true;
  choice.hidden = true;

  if (!activeTab || !activeOrigin) {
    siteEl.textContent = i18n.t("popupNoPage");
    siteEl.className = "ub-status";
    agentEl.textContent = "";
    return;
  }

  const resolved = conns.resolveForOrigin(state.connections, state.activeByOrigin, activeOrigin);

  // The chooser is offered whenever the origin has more than one connection,
  // including when a choice is already made, so the user can switch explicitly
  // instead of being stuck with whatever was chosen first.
  if (resolved.candidates.length > 1) {
    choice.hidden = false;
    chooser.innerHTML = "";
    for (const id of resolved.candidates) {
      const c = state.connections[id];
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = connectionLabel(c) + " · " + conns.relayHost(c.relayUrl);
      chooser.appendChild(opt);
    }
    if (resolved.connection) chooser.value = resolved.connection.connectionId;
  }

  if (!resolved.connection) {
    if (resolved.candidates.length > 1) {
      siteEl.textContent = i18n.t("popupAmbiguousTitle");
      siteEl.className = "ub-status ub-warn";
      agentEl.textContent = i18n.t("popupAmbiguousHint");
    } else {
      siteEl.textContent = i18n.t("popupNotConnected");
      siteEl.className = "ub-status";
      agentEl.textContent = i18n.t("popupNotConnectedHint", { settings: i18n.t("popupSettingsButton") });
    }
    return;
  }

  const conn = resolved.connection;
  siteEl.textContent = connectionLabel(conn);
  siteEl.className = "ub-status ub-ok";
  agentEl.textContent = agentText(conn);

  const granted = await hasSitePermission(conn.origin);
  if (!granted) {
    hintEl.hidden = false;
    hintEl.textContent = i18n.t("popupPermissionHint");
    grantBtn.hidden = false;
    return;
  }
  startBtn.hidden = false;
}

// --- settings ---------------------------------------------------------------

function statusClass(status) {
  if (status === "online") return "ub-conn-status ub-ok";
  if (status === "unauthorized") return "ub-conn-status ub-err";
  return "ub-conn-status ub-muted";
}

function renderConnection(conn) {
  const probe = probes[conn.connectionId] || { status: "unknown", agents: [] };
  const card = document.createElement("div");
  card.className = "ub-conn";

  const head = document.createElement("div");
  head.className = "ub-conn-head";
  const name = document.createElement("span");
  name.className = "ub-conn-name";
  name.textContent = connectionLabel(conn);
  const status = document.createElement("span");
  status.className = statusClass(probe.status);
  status.textContent = conns.statusLabel(probe.status, i18n.t);
  head.appendChild(name);
  head.appendChild(status);

  const meta = document.createElement("div");
  meta.className = "ub-conn-meta";
  // The Relay is only shown when it is needed to tell connections apart.
  meta.textContent = state.needsRelayLabel
    ? i18n.t("popupConnectionVia", { origin: conn.origin, relay: conns.relayHost(conn.relayUrl) })
    : conn.origin;

  const agentRow = document.createElement("label");
  agentRow.className = "ub-conn-agent";
  const agentLabelEl = document.createElement("span");
  agentLabelEl.className = "ub-label";
  agentLabelEl.textContent = i18n.t("popupAgentLabel");
  const select = document.createElement("select");
  select.className = "ub-conn-agent-select";
  const options = conns.agentOptions(probe.agents, conn.agentId, i18n.t);
  const none = document.createElement("option");
  none.value = "";
  none.textContent = i18n.t("popupAgentAutomatic");
  select.appendChild(none);
  for (const a of options) {
    const opt = document.createElement("option");
    opt.value = a.agentId;
    opt.textContent = a.connected ? a.name : i18n.t("agentOffline", { name: a.name });
    select.appendChild(opt);
  }
  select.value = conn.agentId || "";
  select.disabled = probe.status !== "online" && probe.status !== "unknown";
  select.addEventListener("change", async () => {
    const chosen = options.find((a) => a.agentId === select.value);
    const resp = await send({
      type: "setAgent",
      connectionId: conn.connectionId,
      agentId: select.value,
      agentName: chosen ? chosen.name : "",
    });
    if (resp && resp.ok) {
      state = resp.state;
      await renderAll();
    } else {
      showError(i18n.t("errSaveAgent"));
    }
  });
  agentRow.appendChild(agentLabelEl);
  agentRow.appendChild(select);

  const actions = document.createElement("div");
  actions.className = "ub-conn-actions";
  const disconnect = document.createElement("button");
  disconnect.type = "button";
  disconnect.className = "ub-btn ub-btn-danger";
  disconnect.textContent = i18n.t(armingDisconnect === conn.connectionId ? "popupDisconnectConfirm" : "popupDisconnect");
  disconnect.addEventListener("click", async () => {
    if (armingDisconnect !== conn.connectionId) {
      armingDisconnect = conn.connectionId;
      renderAll();
      return;
    }
    armingDisconnect = null;
    const resp = await send({ type: "disconnect", connectionId: conn.connectionId });
    if (resp && resp.ok) {
      state = resp.state;
      delete probes[conn.connectionId];
      await renderAll();
    } else {
      showError(i18n.t("errDisconnectSite"));
    }
  });
  actions.appendChild(disconnect);

  card.appendChild(head);
  card.appendChild(meta);
  card.appendChild(agentRow);
  card.appendChild(actions);
  return card;
}

function renderSettings() {
  const list = el("connection-list");
  list.innerHTML = "";
  const ids = Object.keys(state.connections).sort();
  if (ids.length === 0) {
    const empty = document.createElement("p");
    empty.className = "ub-note";
    empty.textContent = i18n.t("popupEmptyConnections");
    list.appendChild(empty);
    return;
  }
  for (const id of ids) list.appendChild(renderConnection(state.connections[id]));
}

async function probeAll() {
  const ids = Object.keys(state.connections);
  probes = {};
  await Promise.all(
    ids.map(async (id) => {
      const resp = await send({ type: "listAgents", connectionId: id });
      probes[id] = {
        status: conns.statusFromProbe(resp),
        agents: resp && resp.ok ? resp.agents : [],
      };
    })
  );
}

async function renderAll() {
  await renderPage();
  renderSettings();
}

// --- import / grant / start -------------------------------------------------

// ensureRelayPermission asks for the host permission the Relay in the imported
// file needs. A canonical build already ships that permission, so this is a
// no-op there; a portable build asks once per Relay origin — the click that
// opened the file picker is the user gesture Chrome requires.
async function ensureRelayPermission(relayUrl) {
  if (!policy || policy.PORTABLE !== true) return true;
  if (policy.isAllowedRelay(relayUrl)) return true;
  const origin = policy.relayOrigin(relayUrl);
  if (!origin) return false;
  try {
    // A grant from an earlier import is enough: never ask twice for the same Relay.
    if (await chrome.permissions.contains({ origins: [origin + "/*"] })) return true;
    return (await chrome.permissions.request({ origins: [origin + "/*"] })) === true;
  } catch (_) {
    return false;
  }
}

el("import").addEventListener("click", () => el("file").click());

el("file").addEventListener("change", async () => {
  const file = el("file").files && el("file").files[0];
  el("file").value = "";
  if (!file) return;
  showError("");

  let parsed;
  try {
    parsed = pair.parseUllabellaFile(await file.text());
  } catch (e) {
    showError(friendlyPairError(e));
    return;
  }

  if (!(await ensureRelayPermission(parsed.relayUrl))) {
    showError(i18n.t("errRelayPermission"));
    return;
  }

  const importBtn = el("import");
  importBtn.disabled = true;
  importBtn.textContent = i18n.t("popupAdding");

  const resp = await send({ type: "redeemInvite", relayUrl: parsed.relayUrl, invite: parsed.invite });

  importBtn.disabled = false;
  importBtn.textContent = i18n.t("popupAddSite");

  if (!resp || !resp.ok) {
    showError(friendlyPairError(resp && resp.error));
    return;
  }
  await loadState();
  await probeAll();
  await renderAll();
});

el("grant-access").addEventListener("click", async () => {
  showError("");
  const resolved = conns.resolveForOrigin(state.connections, state.activeByOrigin, activeOrigin);
  if (!resolved.connection) return;
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [resolved.connection.origin + "/*"] });
  } catch (_) {
    granted = false;
  }
  if (granted !== true) {
    showError(i18n.t("errPermissionRetry"));
    await renderAll();
    return;
  }
  await send({ type: "registerSite", origin: resolved.connection.origin });
  await renderAll();
});

el("start-editing").addEventListener("click", () => {
  if (!activeTab || activeTab.id == null) return;
  chrome.tabs.sendMessage(activeTab.id, { type: "ubToggle" }).catch(() => {});
  window.close();
});

el("connection-choice").addEventListener("change", async () => {
  const resp = await send({
    type: "setActiveConnection",
    origin: activeOrigin,
    connectionId: el("connection-choice").value,
  });
  if (resp && resp.ok) {
    state = resp.state;
    await renderAll();
  } else {
    showError(i18n.t("errSaveChoice"));
  }
});

// The language selector: the choice is stored by the service worker (the same
// single-writer settings path as everything else) and applied here immediately.
el("language-choice").addEventListener("change", async () => {
  const choice = el("language-choice").value;
  const resp = await send({ type: "setLanguage", language: choice });
  if (!resp || !resp.ok) {
    showError(i18n.t("errSaveLanguage"));
    renderLanguage();
    return;
  }
  showError("");
  languageChoice = i18n.normalizeChoice(choice);
  i18n.setLanguage(languageChoice);
  applyStaticCopy();
  renderLanguage();
  await renderAll();
});

el("toggle-settings").addEventListener("click", async () => {
  const settings = el("settings");
  const open = settings.hidden;
  settings.hidden = !open;
  el("toggle-settings").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    await probeAll();
    renderSettings();
    await renderPage();
  }
});

// --- boot -------------------------------------------------------------------

(async function boot() {
  // The popup's own language: the stored choice decides, "Automatic" follows the
  // browser's UI language, English is the fallback. Read directly from
  // chrome.storage.local — the same key the content script and the worker use.
  const stored = await chrome.storage.local.get(i18n.LANG_KEY);
  languageChoice = i18n.normalizeChoice(stored && stored[i18n.LANG_KEY]);
  i18n.setLanguage(languageChoice);
  applyStaticCopy();
  renderLanguage();

  activeTab = await getActiveTab();
  if (activeTab && activeTab.url) {
    try {
      activeOrigin = new URL(activeTab.url).origin;
    } catch (_) {
      activeOrigin = null;
    }
  }
  await loadState();
  await probeAll();
  await renderAll();

  // Keep the popup in step with a change made elsewhere (another popup window,
  // a background disconnect) without losing what the user is looking at.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    // A language chosen in another popup window applies here too.
    if (changes[i18n.LANG_KEY]) {
      languageChoice = i18n.normalizeChoice(changes[i18n.LANG_KEY].newValue);
      i18n.setLanguage(languageChoice);
      applyStaticCopy();
      renderLanguage();
      await renderAll();
      return;
    }
    if (changes[conns.STORE_KEY] || changes[conns.ACTIVE_KEY] || changes[conns.REMOVED_KEY]) {
      await loadState();
      await probeAll();
      await renderAll();
    }
  });
})();
