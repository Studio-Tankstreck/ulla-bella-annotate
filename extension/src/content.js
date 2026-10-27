// Ulla-Bella Extension — content script (annotation queue UI).
// Registered only on a paired Site origin (chrome.scripting, see background.js),
// then self-gates again by origin: annotation mode is available only when the
// current page matches the paired Site in chrome.storage.local. On any other
// page toggle() is a no-op and Ulla-Bella never enters editing mode.
// Injects nothing permanent: every DOM change is namespaced and removed on exit.
//
// The queue lives in a SESSION document (src/session.js): one session per
// connected site + page, with its own id, description, annotations, submitted
// round and tombstones. Removals are tombstoned and every write is a merge, so
// a reload, a second tab or a late job status can never put a removed
// annotation back (docs/SESSIONS.md).
(function () {
  "use strict";

  // Guard against double-injection: a dynamically registered content script plus
  // an executeScript into an already-open tab can both run this file.
  if (globalThis.__ullabellaInjected) return;
  globalThis.__ullabellaInjected = true;

  const ub = globalThis.UllaBella;
  const q = globalThis.UllaBellaQueue;
  const sessionMod = globalThis.UllaBellaSession;
  const conns = globalThis.UllaBellaConnections;
  // Every user-visible string in this file comes from the locale files via
  // i18n.t / i18n.tn; nothing here hard-codes copy.
  const i18n = globalThis.UllaBellaI18n;

  // connection = the one connection THIS page's edits belong to. It is resolved
  // per tab from the stored connections and the page origin, so a choice made
  // for one origin can never route another tab's changes.
  let connection = null;
  let connectionCandidates = [];
  let connectionAmbiguous = false;
  let sitePromise = null; // memoized single-flight resolution

  let active = false;
  let session = null;    // the live session document — single source of truth
  let sessKey = null;    // chrome.storage key of this session
  const anchors = new Map(); // annotationId -> live DOM element (never persisted)
  let markers = [];      // [{ annotationId, element, el, number }]
  let editingId = null;  // annotationId being edited in the panel (null = new)
  let selectedElement = null;
  let selectedTarget = null;
  let panelEl = null;
  let highlightEl = null;
  let busy = false;
  let clearArmed = false;

  // Etapp 2 state: the first-step modal, the description editor, the marker
  // comment popover, and the save status the user can act on.
  let introEl = null;
  let descEditing = false;
  let commentEl = null;
  let commentForId = null;
  let commentAnchor = null;
  let saveState = "saved"; // "saved" | "unsaved" | "refused"
  let conflict = null;     // { lost: [{annotationId, instruction}], reason }
  let clearArmedTimer = null;

  const SKIP_TAGS = new Set([
    "html", "head", "body", "script", "style", "link", "meta", "title",
    "noscript", "iframe",
  ]);

  function isOwnNode(node) {
    return !!(node && node.closest && node.closest(".ullabella-ui"));
  }

  // selectableFrom climbs from the target to the nearest selectable element,
  // skipping extension UI and non-content tags.
  function selectableFrom(node) {
    let el = node;
    while (el && el.nodeType === 1) {
      if (SKIP_TAGS.has(el.tagName.toLowerCase())) return null;
      if (!isOwnNode(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "ubToggle") toggle();
    else if (msg.type === "ubJobStatus") onStatus(msg);
  });

  // resolveConnection picks the connection THIS page belongs to, from
  // chrome.storage.local. With more than one connection for the same origin it
  // refuses to guess: the user must choose, and that choice is per origin.
  function resolveConnection() {
    if (!sitePromise) {
      sitePromise = loadConnection();
    }
    return sitePromise;
  }

  async function loadConnection() {
    try {
      const data = await chrome.storage.local.get([
        conns.STORE_KEY,
        conns.ACTIVE_KEY,
        conns.REMOVED_KEY,
        conns.LEGACY_SITE_KEY,
        conns.MIGRATED_KEY,
        i18n.LANG_KEY,
      ]);
      // The language choice is read in the same pass as the connection, before
      // any UI exists, so the first render is already in the right language.
      i18n.setLanguage(data && data[i18n.LANG_KEY]);
      const migrated = conns.migrate(data);
      const resolved = conns.resolveForOrigin(
        migrated.connections,
        migrated.activeByOrigin,
        location.origin
      );
      connection = resolved.connection;
      connectionCandidates = resolved.candidates;
      connectionAmbiguous = resolved.ambiguous;
      return connection;
    } catch (_) {
      // storage unavailable (dev shim) — treat as unconfigured.
      connection = null;
      connectionCandidates = [];
      connectionAmbiguous = false;
      return null;
    }
  }

  async function toggle() {
    if (active) {
      exit();
      return;
    }
    const conn = await resolveConnection();
    if (!conn) {
      // Either this page does not belong to a connection, or several do and the
      // user has not chosen. Both keep annotation mode off; the popup explains.
      console.log(
        connectionAmbiguous
          ? "[Ulla-Bella] several connections serve " + location.origin + " — choose one in the extension popup"
          : "[Ulla-Bella] this page is not connected"
      );
      return;
    }
    enter();
  }

  // --- enter / exit --------------------------------------------------------

  function enter() {
    if (active) return;
    active = true;
    ensureHighlight();
    document.addEventListener("mouseover", onHover, true);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("resize", onScroll, true);
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("click", onClick, true);
    // A window resize (including a browser zoom change) can shrink the viewport
    // under an open comment; re-fit it.
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("resize", onScroll, true);
    }
    document.documentElement.style.cursor = "crosshair";
    restore().then(function () {
      if (!active) return;
      // A write that was never acknowledged (worker killed mid-message) is
      // re-sent now; the merge is idempotent.
      flushUnsaved();
      renderMarkers();
      maybeShowIntro();
      const job = currentJob();
      if (job && job.jobId && (job.status === "sending" || job.status === "submitted")) {
        ensurePanel();
        renderPanel();
        resumeJob(job.jobId);
      }
    });
  }

  function exit() {
    if (!active) return;
    active = false;
    closeComment();
    closeIntro();
    document.removeEventListener("mouseover", onHover, true);
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("resize", onScroll, true);
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("click", onClick, true);
    if (typeof window !== "undefined" && window.removeEventListener) {
      window.removeEventListener("resize", onScroll, true);
    }
    document.documentElement.style.cursor = "";
    removeHighlight();
    removePanel();
    removeMarkers();
    selectedElement = null;
    selectedTarget = null;
    editingId = null;
    clearArmed = false;
  }

  function onKeydown(e) {
    if (e.key !== "Escape") return;
    // Escape closes the topmost thing first: the marker comment, then the
    // first-step modal, and only then annotation mode.
    if (commentEl) {
      e.preventDefault();
      e.stopPropagation();
      closeComment();
      return;
    }
    if (introEl) {
      e.preventDefault();
      e.stopPropagation();
      finishIntro("skipped");
      return;
    }
    exit();
  }

  // --- highlight -----------------------------------------------------------

  function ensureHighlight() {
    if (highlightEl) return;
    highlightEl = document.createElement("div");
    highlightEl.className = "ullabella-ui ullabella-highlight";
    highlightEl.style.display = "none";
    document.documentElement.appendChild(highlightEl);
  }

  function onHover(e) {
    if (!active) return;
    const el = selectableFrom(e.target);
    if (!el) return hideHighlight();
    positionHighlight(el);
  }

  function onHoverOut() {
    hideHighlight();
  }

  function positionHighlight(el) {
    const r = el.getBoundingClientRect();
    highlightEl.style.display = "block";
    highlightEl.style.top = (r.top + window.scrollY) + "px";
    highlightEl.style.left = (r.left + window.scrollX) + "px";
    highlightEl.style.width = r.width + "px";
    highlightEl.style.height = r.height + "px";
  }

  function hideHighlight() {
    if (highlightEl) highlightEl.style.display = "none";
  }

  function removeHighlight() {
    if (highlightEl && highlightEl.parentNode) highlightEl.parentNode.removeChild(highlightEl);
    highlightEl = null;
  }

  // --- selection -----------------------------------------------------------

  function onClick(e) {
    if (!active) return;
    // Let clicks inside Ulla-Bella's own UI (panel buttons, textarea, close,
    // markers, the comment popover) reach their own listeners: this
    // capture-phase handler must not swallow them.
    if (isOwnNode(e.target)) return;
    // A click outside an open comment dismisses it — and only dismisses it, so
    // the same click cannot also select a new page element.
    if (commentEl) {
      e.preventDefault();
      e.stopPropagation();
      closeComment();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const el = selectableFrom(e.target);
    if (!el) return;
    if (introEl) {
      // The user started annotating instead of answering: treat it as an
      // explicit skip so the step never blocks and never comes back.
      finishIntro("skipped");
    }
    selectedElement = el;
    selectedTarget = capture(el);
    editingId = null;
    clearArmed = false;
    hideHighlight();
    openPanelForNew();
  }

  function capture(el) {
    const rect = el.getBoundingClientRect();
    return {
      url: location.href,
      pageTitle: document.title,
      elementType: el.tagName.toLowerCase(),
      visibleText: elementText(el),
      selector: ub.buildSelector(el),
      domPath: ub.buildDomPath(el),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      nearbyText: nearbyText(el),
    };
  }

  function elementText(el) {
    const text = (el.innerText !== undefined ? el.innerText : el.textContent) || "";
    return text.replace(/\s+/g, " ").trim().slice(0, 200);
  }

  function nearbyText(el) {
    // Best-effort: the nearest ancestor's text, minus the element's own text.
    const parent = el.parentElement;
    if (!parent) return "";
    const own = elementText(el);
    let text = (parent.innerText !== undefined ? parent.innerText : parent.textContent) || "";
    text = text.replace(/\s+/g, " ").trim();
    if (own && text.indexOf(own) !== -1) text = text.replace(own, " ");
    return text.replace(/\s+/g, " ").trim().slice(0, 300);
  }

  // --- session accessors ---------------------------------------------------

  function queueList() {
    return session ? session.annotations : [];
  }

  function currentJob() {
    return session ? session.job : null;
  }

  function sessionMeta() {
    // siteId carries the CONNECTION id: sessions, queues and job records are
    // keyed per connection, so two relays hosting the same siteId (or the same
    // site paired twice) can never share a queue.
    return {
      siteId: connection ? connection.connectionId : null,
      siteName: connection ? connection.displayName || connection.origin : "",
      pageId: q.pageId(location.href),
      pageUrl: location.href,
    };
  }

  // sessionIdentity is what the panel (and the Clear button) names, so a
  // destructive action can never be mistaken for another session's.
  function sessionIdentity() {
    const s = session || {};
    const name = s.siteName || (connection && (connection.displayName || connection.origin)) || "";
    let path = "/";
    try {
      path = new URL(s.pageUrl || location.href).pathname || "/";
    } catch (_) {
      path = "/";
    }
    return (name ? name + " · " : "") + path;
  }

  function findById(id) {
    for (const a of queueList()) {
      if (a.annotationId === id) return a;
    }
    return null;
  }

  // --- persistence (single writer: the service worker) ---------------------

  // Marks a pre-etapp-3 (siteId-keyed) session as imported into its connection.
  const SESSION_MIGRATED_KEY = "ub.migrated.sessions";

  // All storage access in THIS tab is serialized, so a restore can never read a
  // snapshot taken before a write that already happened here.
  let writeTail = Promise.resolve();

  function serialize(task) {
    const run = writeTail.then(task, task);
    writeTail = run.then(function () {}, function () {});
    return run;
  }

  // The session document is written by the service worker ONLY (message
  // "writeSession"): one queue per session key, read-merge-write on the worker
  // side. Two tabs can therefore never interleave a read with each other's
  // write, which is what used to lose deletions. This tab only ever reads.
  const WRITE_ATTEMPTS = 3;
  const WRITE_RETRY_MS = 40;
  let unsavedSnapshot = null;

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function persist(extra) {
    if (!session || !sessKey) return Promise.resolve(null);
    const snapshot = session;
    return serialize(function () {
      return sendWrite(sessKey, snapshot, extra);
    }).then(function (outcome) {
      handleWriteOutcome(outcome);
      return session;
    });
  }

  // flushUnsaved re-sends a document whose write never got acknowledged (worker
  // killed mid-message). The merge is idempotent, so this converges.
  function flushUnsaved() {
    if (!unsavedSnapshot || !sessKey) return Promise.resolve(null);
    const snap = unsavedSnapshot;
    unsavedSnapshot = null;
    return serialize(function () {
      return sendWrite(sessKey, snap, null);
    }).then(function (outcome) {
      handleWriteOutcome(outcome);
      return session;
    });
  }

  // handleWriteOutcome keeps the user informed instead of silently dropping
  // anything: a refused write and an unacknowledged write are both visible and
  // actionable in the panel (etapp 2, point 4).
  function handleWriteOutcome(outcome) {
    if (!outcome) return;
    if (outcome.session) {
      if (outcome.written) {
        applySession(outcome.session);
        if (!conflict) saveState = "saved";
      } else {
        // Refused: adopt what is stored, but report — and keep — what the user
        // wrote in the document that was refused.
        applySession(outcome.session, outcome.sent);
      }
    } else if (outcome.failed) {
      saveState = "unsaved";
    }
    renderSavebar();
  }

  // lostAgainst lists the annotations of `sent` (or of the live session when
  // nothing was sent) that the incoming document does not have and has not
  // deleted — i.e. the user's work that a clear elsewhere dropped.
  function lostAgainst(stored, sent) {
    const source = sent && Array.isArray(sent.annotations) ? sent.annotations : queueList();
    const keep = Object.create(null);
    for (const a of (stored && stored.annotations) || []) keep[a.annotationId] = true;
    const tombstones = (stored && stored.deleted) || {};
    const out = [];
    for (const a of source) {
      if (keep[a.annotationId] || tombstones[a.annotationId]) continue;
      out.push({ annotationId: a.annotationId, instruction: a.instruction, target: a.target });
    }
    return out;
  }

  // lostDescription returns the session description the user had in `sent` (or
  // locally) when the stored document holds a different one — the description
  // half of the same refusal. Nothing is ever restored from this automatically.
  function lostDescription(stored, sent) {
    const text = (
      (sent && typeof sent.description === "string" ? sent.description : session && session.description) || ""
    ).trim();
    if (!text) return null;
    const kept = ((stored && typeof stored.description === "string" ? stored.description : "") || "").trim();
    return kept === text ? null : text;
  }

  // sendWrite retries a transport failure (the MV3 worker can be killed
  // mid-message). A retry re-sends the whole document, and the merge is
  // idempotent, so a retry after a write that did land changes nothing.
  function sendWrite(key, snapshot, extra) {
    let attempt = 0;

    function tryOnce() {
      attempt += 1;
      return new Promise(function (resolve) {
        const msg = { type: "writeSession", sessionKey: key, session: snapshot };
        if (extra && extra.migrate) msg.migrate = true;
        let settled = false;
        const done = function (result) {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        try {
          chrome.runtime.sendMessage(msg, function (resp) {
            const lastError = chrome.runtime.lastError;
            if (lastError || !resp) {
              done({ retry: true });
              return;
            }
            if (resp.ok !== true) {
              done({ retry: false, session: null, failed: true });
              return;
            }
            done({
              retry: false,
              session: resp.session || null,
              written: resp.written !== false,
              reason: resp.reason || null,
            });
          });
        } catch (_) {
          done({ retry: true });
        }
      });
    }

    function loop() {
      return tryOnce().then(function (outcome) {
        if (!outcome.retry) {
          unsavedSnapshot = outcome.failed ? snapshot : null;
          return {
            session: outcome.session,
            written: outcome.written !== false,
            reason: outcome.reason || null,
            failed: !!outcome.failed,
            // The exact document this attempt sent: if the write is refused,
            // the user's text must be read back from HERE, not from whatever
            // the local session looks like by the time the answer arrives.
            sent: snapshot,
          };
        }
        if (attempt >= WRITE_ATTEMPTS) {
          // Keep the intent locally; the next persist() resends everything.
          unsavedSnapshot = snapshot;
          return { session: null, written: false, reason: "unacknowledged", failed: true, sent: snapshot };
        }
        return delay(WRITE_RETRY_MS * attempt).then(loop);
      });
    }

    return loop();
  }

  function restore() {
    return serialize(function () {
      return loadSession();
    });
  }

  async function loadSession() {
    const meta = sessionMeta();
    sessKey = sessionMod.storageKey(meta.siteId, meta.pageId);
    // Sessions were keyed by siteId before etapp 3; the same session is now keyed
    // by connection id. The old document is imported ONCE, and only for the
    // connection that came from the single-pairing migration (see below) — a
    // second relay with the same siteId must not inherit it.
    const legacySessionKey = connection ? sessionMod.storageKey(connection.siteId, meta.pageId) : null;
    let stored = null;
    try {
      const keys = [sessKey, sessionMod.LEGACY_KEY, sessionMod.MIGRATED_KEY, SESSION_MIGRATED_KEY];
      if (legacySessionKey && legacySessionKey !== sessKey) keys.push(legacySessionKey);
      const data = await chrome.storage.local.get(keys);
      stored = data && data[sessKey];
      if (!stored && connection && connection.migratedFrom === "site" && legacySessionKey) {
        // Pre-etapp-3 session for this site: adopt it verbatim (same sessionId,
        // lineage and tombstones) so nothing is lost or resurrected.
        const legacyDoc = data && data[legacySessionKey];
        const migratedMap = (data && data[SESSION_MIGRATED_KEY]) || {};
        if (legacyDoc && !migratedMap[sessKey]) {
          const outcome = await sendWrite(sessKey, legacyDoc, {});
          stored = (outcome && outcome.session) || legacyDoc;
          const nextMap = Object.assign({}, migratedMap);
          nextMap[sessKey] = Date.now();
          try {
            await chrome.storage.local.set({ [SESSION_MIGRATED_KEY]: nextMap });
          } catch (_) {
            // best-effort marker; the copy is already in place
          }
        }
      }
      if (!stored) {
        // Compatible migration of the pre-2.2 `queues[pageId]` entry: imported
        // once, never again (a later deletion must not be re-imported). The
        // import and its marker are written by the worker in one set call.
        const legacyMap = (data && data[sessionMod.LEGACY_KEY]) || null;
        const migrated = (data && data[sessionMod.MIGRATED_KEY]) || {};
        const legacy = legacyMap && legacyMap[meta.pageId];
        if (legacy && !migrated[sessKey]) {
          const imported = sessionMod.fromLegacy(legacy, meta);
          const outcome = await sendWrite(sessKey, imported, { migrate: true });
          stored = (outcome && outcome.session) || imported;
        }
      }
    } catch (_) {
      // storage unavailable — start empty.
    }
    applySession(stored || sessionMod.empty(meta));
    return session;
  }

  // applySession adopts a session document into memory: anchors are re-bound
  // best-effort and the UI re-renders. It never writes. When the incoming
  // document is a LATER generation (cleared elsewhere), anything the user had in
  // `sent` (or locally) and the incoming document no longer has — annotations
  // AND the session description — is reported instead of vanishing silently.
  function applySession(next, sent) {
    const normalized = sessionMod.normalize(next, sessionMeta());
    if (session && (normalized.generation || 0) > (session.generation || 0)) {
      const lost = lostAgainst(normalized, sent);
      const lostDesc = lostDescription(normalized, sent);
      if (lost.length || lostDesc) {
        conflict = { lost: lost, lostDescription: lostDesc, reason: "cleared" };
        saveState = "refused";
      }
    }
    session = normalized;
    for (const id of Array.from(anchors.keys())) {
      if (!findById(id)) anchors.delete(id);
    }
    for (const a of session.annotations) {
      if (!anchors.has(a.annotationId)) {
        const el = findElement(a.target);
        if (el) anchors.set(a.annotationId, el);
      }
    }
    if (commentForId && !findById(commentForId)) closeComment();
    if (active) {
      renderPanel();
      renderMarkers();
    }
  }

  // findElement re-anchors a stored annotation to a live element, best-effort:
  // selector first, then visible text. Returns null when the element is gone.
  function findElement(target) {
    if (!target) return null;
    if (target.selector) {
      try {
        const el = document.querySelector(target.selector);
        if (el) return el;
      } catch (_) {
        // invalid selector — fall through to text match.
      }
    }
    if (target.visibleText) {
      const tag = target.elementType || "*";
      let all;
      try {
        all = document.querySelectorAll(tag);
      } catch (_) {
        return null;
      }
      for (const el of all) {
        if (elementText(el) === target.visibleText) return el;
      }
    }
    return null;
  }

  // --- queue operations ----------------------------------------------------

  function addOrSave() {
    if (!panelEl || !session) return;
    const input = panelEl.querySelector(".ullabella-input");
    const instruction = input.value.trim();
    if (!instruction) {
      input.focus();
      return;
    }
    clearArmed = false;
    if (editingId) {
      session = sessionMod.withInstruction(session, editingId, instruction);
    } else if (selectedTarget) {
      if (queueList().length >= q.MAX) {
        setStatus(i18n.t("statusQueueFull", { count: i18n.n(q.MAX), max: i18n.n(q.MAX) }), "error");
        return;
      }
      const id = ub.newId("ann");
      const ts = new Date().toISOString();
      session = sessionMod.withAnnotations(session, queueList().concat([{
        annotationId: id,
        instruction: instruction,
        target: selectedTarget,
        createdAt: ts,
        updatedAt: ts,
      }]));
      if (selectedElement) anchors.set(id, selectedElement);
    } else {
      return;
    }
    editingId = null;
    selectedElement = null;
    selectedTarget = null;
    persist();
    renderPanel();
    renderMarkers();
    setStatus("", "");
  }

  function editAnnotation(id) {
    const a = findById(id);
    if (!a) return;
    editingId = id;
    openPanelForEdit(a);
  }

  // deleteAnnotation removes ONE annotation from THIS session: queue, markers
  // and stored state (via a tombstone). It never claims to cancel a round that
  // has already been sent — see the status message when one is running.
  function deleteAnnotation(id) {
    if (!session) return;
    const job = currentJob();
    const running = !!(job && job.jobId && !sessionMod.isTerminalJob(job));
    session = sessionMod.removeAnnotation(session, id);
    anchors.delete(id);
    clearArmed = false;
    if (commentForId === id) closeComment();
    if (editingId === id) {
      editingId = null;
      selectedElement = null;
      selectedTarget = null;
      if (panelEl) panelEl.classList.remove("ullabella-open");
    }
    persist();
    renderPanel();
    renderMarkers();
    if (running) {
      setStatus(i18n.t("statusDeletedRunning"), "");
    } else {
      setStatus("", "");
    }
  }

  // clearSession is the panel's "Clear session": one session only, confirmed by
  // a second click that names the session.
  function clearSession() {
    if (!session) return;
    const job = currentJob();
    const running = !!(job && job.jobId && !sessionMod.isTerminalJob(job));
    if (!clearArmed) {
      clearArmed = true;
      updateClearButton();
      setStatus(i18n.t("statusClearConfirm", { session: sessionIdentity() }), "");
      // The armed state expires on its own so a stray second click much later
      // cannot clear the session.
      if (clearArmedTimer) clearTimeout(clearArmedTimer);
      clearArmedTimer = setTimeout(function () {
        clearArmedTimer = null;
        clearArmed = false;
        if (panelEl) updateClearButton();
      }, 5000);
      return;
    }
    if (clearArmedTimer) {
      clearTimeout(clearArmedTimer);
      clearArmedTimer = null;
    }
    clearArmed = false;
    session = sessionMod.clear(session);
    anchors.clear();
    closeComment();
    conflict = null;
    saveState = "saved";
    editingId = null;
    selectedElement = null;
    selectedTarget = null;
    if (panelEl) panelEl.classList.remove("ullabella-open");
    hideProgress();
    persist();
    renderPanel();
    renderMarkers();
    updateClearButton();
    if (running) {
      setStatus(i18n.t("statusClearedRunning"), "");
    } else {
      setStatus(i18n.t("statusCleared"), "");
    }
  }

  // --- markers -------------------------------------------------------------

  function renderMarkers() {
    removeMarkers();
    const isTerminal = terminal();
    queueList().forEach(function (a, i) {
      const el = document.createElement("div");
      el.className = "ullabella-ui ullabella-marker";
      const rm = resultMark(a);
      el.textContent = rm.label != null ? rm.label : String(i + 1);
      if (rm.cls) el.classList.add(rm.cls);
      const target = anchors.get(a.annotationId);
      if (!target || !target.isConnected) {
        el.classList.add("ullabella-lost");
        el.title = i18n.t("markerLost");
      } else {
        el.title = isTerminal
          ? i18n.t("markerViewResult", { number: i + 1 })
          : i18n.t("markerViewAnnotation", { number: i + 1 });
      }
      // A marker is a button: reachable by keyboard, with the number and the
      // instruction as its accessible name, and it opens the comment popover.
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-haspopup", "dialog");
      el.setAttribute(
        "aria-label",
        a.instruction
          ? i18n.t("markerAriaWithText", { number: i + 1, text: truncate(a.instruction, 90) })
          : i18n.t("markerAria", { number: i + 1 })
      );
      el.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggleComment(a.annotationId, el);
      });
      el.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
        e.preventDefault();
        e.stopPropagation();
        toggleComment(a.annotationId, el);
      });
      document.documentElement.appendChild(el);
      markers.push({ annotationId: a.annotationId, element: target, el: el, number: i + 1 });
    });
    positionMarkers();
    syncCommentAria();
  }

  function truncate(text, max) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
  }

  function positionMarkers() {
    for (const m of markers) {
      if (!m.element || !m.element.isConnected) {
        // Lost element: keep the marker visible at its last position.
        m.el.classList.add("ullabella-lost");
        continue;
      }
      m.el.classList.remove("ullabella-lost");
      const r = m.element.getBoundingClientRect();
      m.el.style.top = (r.top + window.scrollY - 10) + "px";
      m.el.style.left = (r.left + window.scrollX - 10) + "px";
    }
  }

  function removeMarkers() {
    for (const m of markers) {
      if (m.el && m.el.parentNode) m.el.parentNode.removeChild(m.el);
    }
    markers = [];
  }

  let raf = null;
  function onScroll() {
    hideHighlight();
    if (commentEl) {
      if (!commentAnchor || commentAnchor.isConnected === false) closeComment();
      else positionComment();
    }
    if (!markers.length) return;
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = null;
      positionMarkers();
    });
  }

  // --- marker comment popover ----------------------------------------------

  // One comment at a time, anchored at its marker: the full instruction, the
  // marker number, and the result when the round has one. Closing restores
  // focus to the marker; the panel keeps the editing affordance.
  function toggleComment(annotationId, markerEl) {
    if (commentEl && commentForId === annotationId) {
      closeComment(true);
      return;
    }
    openComment(annotationId, markerEl);
  }

  function openComment(annotationId, markerEl) {
    closeComment();
    const a = findById(annotationId);
    if (!a) return;
    commentForId = annotationId;
    commentAnchor = markerEl || null;
    const number = markerNumber(annotationId);

    // Built node by node: the instruction is DATA. It is written with
    // textContent, so markup in a user's instruction can never become HTML.
    const host = document.createElement("div");
    host.className = "ullabella-ui ullabella-comment";
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-modal", "false");
    host.setAttribute("aria-label", i18n.t("commentAria", { number: number }));

    const head = document.createElement("div");
    head.className = "ullabella-comment-head";
    const title = document.createElement("span");
    title.className = "ullabella-comment-title";
    title.textContent = i18n.t("commentTitle", { number: number });
    const close = document.createElement("button");
    close.className = "ullabella-comment-close";
    close.setAttribute("type", "button");
    close.setAttribute("aria-label", i18n.t("commentClose"));
    close.textContent = "\u00d7";
    head.appendChild(title);
    head.appendChild(close);

    const body = document.createElement("div");
    body.className = "ullabella-comment-body";
    body.textContent = a.instruction;

    const result = document.createElement("div");
    result.className = "ullabella-comment-result";
    const resultText = resultTitle(a);
    if (resultText) {
      result.textContent = resultText;
      result.hidden = false;
    } else {
      result.hidden = true;
    }

    const actions = document.createElement("div");
    actions.className = "ullabella-comment-actions";
    const edit = document.createElement("button");
    edit.className = "ullabella-comment-edit";
    edit.setAttribute("type", "button");
    edit.textContent = i18n.t("commentEditInPanel");
    actions.appendChild(edit);

    host.appendChild(head);
    host.appendChild(body);
    host.appendChild(result);
    host.appendChild(actions);
    document.documentElement.appendChild(host);
    commentEl = host;

    close.addEventListener("click", function (e) {
      e.preventDefault();
      closeComment(true);
    });
    edit.addEventListener("click", function (e) {
      e.preventDefault();
      closeComment();
      editAnnotation(annotationId);
    });

    positionComment();
    syncCommentAria();
    if (typeof close.focus === "function") close.focus();
  }

  function markerNumber(annotationId) {
    const list = queueList();
    for (let i = 0; i < list.length; i++) {
      if (list[i].annotationId === annotationId) return i + 1;
    }
    return 0;
  }

  function closeComment(restoreFocus) {
    if (!commentEl) return;
    const anchor = commentAnchor;
    if (commentEl.parentNode) commentEl.parentNode.removeChild(commentEl);
    commentEl = null;
    commentForId = null;
    commentAnchor = null;
    syncCommentAria();
    if (restoreFocus && anchor && typeof anchor.focus === "function") anchor.focus();
  }

  function syncCommentAria() {
    for (const m of markers) {
      if (!m.el || typeof m.el.setAttribute !== "function") continue;
      m.el.setAttribute("aria-expanded", commentForId === m.annotationId ? "true" : "false");
    }
  }

  // positionComment keeps the popover inside the viewport. The panel is capped
  // at the available height/width (CSS keeps the head and the actions pinned and
  // scrolls the body), so its close button and "Edit in panel" stay reachable
  // even with a long instruction on a short window or at high zoom.
  function positionComment() {
    if (!commentEl || !commentAnchor) return;
    const pad = 8;
    const vw = (typeof window !== "undefined" && window.innerWidth) || 1024;
    const vh = (typeof window !== "undefined" && window.innerHeight) || 768;
    const maxH = Math.max(120, vh - pad * 2);
    const maxW = Math.max(200, vw - pad * 2);
    commentEl.style.position = "fixed";
    commentEl.style.maxHeight = maxH + "px";
    commentEl.style.maxWidth = maxW + "px";

    const anchor = commentAnchor.getBoundingClientRect
      ? commentAnchor.getBoundingClientRect()
      : { top: pad, bottom: pad, left: pad };
    const box = commentEl.getBoundingClientRect ? commentEl.getBoundingClientRect() : { width: 0, height: 0 };
    let top = anchor.bottom + 6;
    if (top + box.height > vh - pad) top = anchor.top - box.height - 6;
    // Even flipped, the whole panel must fit (it is height-capped above).
    if (top + box.height > vh - pad) top = vh - pad - box.height;
    if (top < pad) top = pad;
    let left = anchor.left;
    if (left + box.width > vw - pad) left = vw - pad - box.width;
    if (left < pad) left = pad;
    commentEl.style.top = Math.round(top) + "px";
    commentEl.style.left = Math.round(left) + "px";
  }

  // --- panel ---------------------------------------------------------------

  function ensurePanel() {
    if (panelEl) return panelEl;
    const host = document.createElement("div");
    host.className = "ullabella-ui ullabella-panel-host";
    // Structure only (the one innerHTML in this file): every label is written
    // by applyPanelLabels() from the active locale, with textContent, so no copy
    // is hard-coded in markup and a language change can relabel the open panel.
    host.innerHTML =
      '<div class="ullabella-panel">' +
        '<div class="ullabella-head">' +
          '<span class="ullabella-brand">Ulla-Bella</span>' +
          '<span class="ullabella-count"></span>' +
          '<button class="ullabella-close" type="button">&times;</button>' +
        '</div>' +
        '<div class="ullabella-session">' +
          '<span class="ullabella-session-label"></span>' +
          '<button class="ullabella-clear" type="button"></button>' +
        '</div>' +
        '<div class="ullabella-agent">' +
          '<span class="ullabella-agent-label"></span>' +
        '</div>' +
        '<div class="ullabella-desc">' +
          '<div class="ullabella-desc-title"></div>' +
          '<div class="ullabella-desc-body">' +
            '<div class="ullabella-desc-text"></div>' +
            '<div class="ullabella-desc-actions">' +
              '<button class="ullabella-desc-edit" type="button"></button>' +
            '</div>' +
          '</div>' +
          '<div class="ullabella-desc-editor" hidden>' +
            '<textarea class="ullabella-desc-input" rows="3" maxlength="2000"></textarea>' +
            '<div class="ullabella-actions ullabella-desc-editor-actions">' +
              '<button class="ullabella-desc-cancel" type="button"></button>' +
              '<button class="ullabella-desc-save" type="button"></button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="ullabella-savebar" role="status" aria-live="polite" hidden>' +
          '<div class="ullabella-savebar-text"></div>' +
          '<div class="ullabella-savebar-desc" hidden></div>' +
          '<ul class="ullabella-savebar-lost"></ul>' +
          '<div class="ullabella-actions">' +
            '<button class="ullabella-savebar-retry" type="button" hidden></button>' +
            '<button class="ullabella-savebar-readd" type="button" hidden></button>' +
            '<button class="ullabella-savebar-dismiss" type="button" hidden></button>' +
          '</div>' +
        '</div>' +
        '<div class="ullabella-summary"></div>' +
        '<div class="ullabella-list"></div>' +
        '<textarea class="ullabella-input" rows="3"></textarea>' +
        '<div class="ullabella-actions">' +
          '<button class="ullabella-cancel" type="button"></button>' +
          '<button class="ullabella-add" type="button"></button>' +
          '<button class="ullabella-send" type="button"></button>' +
        '</div>' +
        '<div class="ullabella-progress" hidden>' +
          '<span class="ullabella-spinner" aria-hidden="true"></span>' +
          '<div class="ullabella-progress-body">' +
            '<div class="ullabella-progress-title"></div>' +
            '<div class="ullabella-progress-activity"></div>' +
            '<div class="ullabella-progress-meta">' +
              '<span class="ullabella-progress-count"></span>' +
              '<span class="ullabella-progress-elapsed"></span>' +
              '<span class="ullabella-progress-agent"></span>' +
              '<span class="ullabella-progress-checked"></span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="ullabella-status" role="status"></div>' +
      '</div>';
    document.documentElement.appendChild(host);
    panelEl = host;
    applyPanelLabels();

    panelEl.querySelector(".ullabella-close").addEventListener("click", exit);
    panelEl.querySelector(".ullabella-cancel").addEventListener("click", cancelSelection);
    panelEl.querySelector(".ullabella-add").addEventListener("click", addOrSave);
    panelEl.querySelector(".ullabella-send").addEventListener("click", sendAll);
    panelEl.querySelector(".ullabella-clear").addEventListener("click", clearSession);
    panelEl.querySelector(".ullabella-desc-edit").addEventListener("click", beginDescriptionEdit);
    panelEl.querySelector(".ullabella-desc-save").addEventListener("click", saveDescription);
    panelEl.querySelector(".ullabella-desc-cancel").addEventListener("click", cancelDescriptionEdit);
    panelEl.querySelector(".ullabella-savebar-retry").addEventListener("click", retrySave);
    panelEl.querySelector(".ullabella-savebar-readd").addEventListener("click", readdLost);
    panelEl.querySelector(".ullabella-savebar-dismiss").addEventListener("click", dismissConflict);
    return panelEl;
  }

  // applyPanelLabels writes every static panel label from the active locale. It
  // runs when the panel is built and again when the language changes, so a
  // manual choice reaches an already-open panel without reloading the page.
  function applyPanelLabels() {
    if (!panelEl) return;
    const set = function (selector, text) {
      const node = panelEl.querySelector(selector);
      if (node) node.textContent = text;
    };
    const attr = function (selector, name, value) {
      const node = panelEl.querySelector(selector);
      if (node) node.setAttribute(name, value);
    };
    attr(".ullabella-close", "aria-label", i18n.t("panelExitAria"));
    const input = panelEl.querySelector(".ullabella-input");
    if (input) input.setAttribute("placeholder", i18n.t("panelInputPlaceholder"));
    set(".ullabella-desc-title", i18n.t("panelSessionDescription"));
    set(".ullabella-desc-cancel", i18n.t("panelCancel"));
    set(".ullabella-desc-save", i18n.t("panelSaveDescription"));
    set(".ullabella-savebar-retry", i18n.t("panelRetry"));
    set(".ullabella-savebar-dismiss", i18n.t("panelDismiss"));
    set(".ullabella-cancel", i18n.t("panelCancel"));
    set(".ullabella-send", i18n.t("panelSendAll"));
    const add = panelEl.querySelector(".ullabella-add");
    if (add) add.textContent = i18n.t(editingId ? "panelSave" : "panelAddToQueue");
    const descEdit = panelEl.querySelector(".ullabella-desc-edit");
    if (descEdit && !descEditing) {
      const hasText = !!(session && (session.description || "").trim());
      descEdit.textContent = i18n.t(hasText ? "panelEditDescription" : "panelAddDescription");
    }
    updateClearButton();
  }

  function renderPanel() {
    if (!panelEl || !session) return;
    panelEl.querySelector(".ullabella-count").textContent = i18n.n(queueList().length) + " / " + i18n.n(q.MAX);

    const label = panelEl.querySelector(".ullabella-session-label");
    if (label) label.textContent = i18n.t("panelSessionLabel", { session: sessionIdentity() });
    const agentEl = panelEl.querySelector(".ullabella-agent-label");
    if (agentEl) agentEl.textContent = agentLabel();
    updateClearButton();
    renderDescription();
    renderSavebar();

    const list = panelEl.querySelector(".ullabella-list");
    list.innerHTML = "";
    queueList().forEach(function (a, i) {
      const item = document.createElement("div");
      item.className = "ullabella-item" + (a.annotationId === editingId ? " ullabella-editing" : "");
      const num = document.createElement("span");
      num.className = "ullabella-item-num";
      num.textContent = String(i + 1);
      const text = document.createElement("span");
      text.className = "ullabella-item-text";
      text.textContent = a.instruction;
      const res = document.createElement("span");
      res.className = "ullabella-item-result";
      const rm = resultMark(a);
      if (rm.cls) res.classList.add(rm.cls);
      res.textContent = rm.label || "";
      res.title = resultTitle(a);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ullabella-item-del";
      del.setAttribute("aria-label", i18n.t("panelRemoveAria", { number: i + 1 }));
      del.title = i18n.t("panelRemoveTitle");
      del.textContent = "\u00d7";
      item.appendChild(num);
      item.appendChild(text);
      item.appendChild(res);
      item.appendChild(del);
      item.addEventListener("click", function (e) {
        if (e.target === del) {
          deleteAnnotation(a.annotationId);
        } else if (terminal()) {
          showDetail(a);
        } else {
          editAnnotation(a.annotationId);
        }
      });
      list.appendChild(item);
    });

    const add = panelEl.querySelector(".ullabella-add");
    add.textContent = i18n.t(editingId ? "panelSave" : "panelAddToQueue");
    add.disabled = busy || (!editingId && queueList().length >= q.MAX);
    panelEl.querySelector(".ullabella-send").disabled = busy || queueList().length === 0;
  }

  function updateClearButton() {
    if (!panelEl) return;
    const btn = panelEl.querySelector(".ullabella-clear");
    if (!btn) return;
    btn.textContent = i18n.t(clearArmed ? "panelClearConfirm" : "panelClearSession");
    btn.title = i18n.t("panelClearTitle", { session: sessionIdentity() });
    btn.setAttribute("aria-label", i18n.t("panelClearTitle", { session: sessionIdentity() }));
    btn.disabled = !!session && !clearArmed && !hasSomethingToClear();
  }

  // agentLabel names the Hermes agent this page's changes go to. The chosen
  // agent is the Relay-side agent id (which adapter ⇒ which Hermes instance);
  // without a choice the Relay uses an authorized connected agent, which we say.
  function agentLabel() {
    if (!connection) return "";
    if (connection.agentId) {
      return i18n.t("agentChosen", { name: connection.agentName || connection.agentId });
    }
    return i18n.t("agentNotChosen");
  }

  function hasSomethingToClear() {
    if (!session) return false;
    return queueList().length > 0 || (session.description || "") !== "" || !!currentJob();
  }

  // --- session description -------------------------------------------------

  function beginDescriptionEdit() {
    if (!panelEl || !session) return;
    descEditing = true;
    renderPanel();
    const input = panelEl.querySelector(".ullabella-desc-input");
    input.value = session.description || "";
    if (typeof input.focus === "function") input.focus();
  }

  function saveDescription() {
    if (!panelEl || !session) return;
    const input = panelEl.querySelector(".ullabella-desc-input");
    session = sessionMod.withDescription(session, (input.value || "").trim());
    descEditing = false;
    persist();
    renderPanel();
    setStatus("", "");
  }

  function cancelDescriptionEdit() {
    descEditing = false;
    renderPanel();
  }

  function renderDescription() {
    if (!panelEl || !session) return;
    const text = (session.description || "").trim();
    const view = panelEl.querySelector(".ullabella-desc-body");
    const editor = panelEl.querySelector(".ullabella-desc-editor");
    const textEl = panelEl.querySelector(".ullabella-desc-text");
    const btn = panelEl.querySelector(".ullabella-desc-edit");
    if (descEditing) {
      if (view) view.hidden = true;
      if (editor) editor.hidden = false;
      return;
    }
    if (editor) editor.hidden = true;
    if (view) view.hidden = false;
    if (textEl) {
      // User text is rendered as TEXT, never as HTML.
      textEl.textContent = text || i18n.t("panelNoDescription");
      textEl.className = "ullabella-desc-text" + (text ? "" : " ullabella-muted");
      // A truncated description fades out at its last line: the scrollbar alone
      // is easy to miss, and text that just stops reads as broken.
      if (text && textEl.scrollHeight > textEl.clientHeight + 2) {
        textEl.className += " ullabella-desc-clipped";
      }
    }
    if (btn) btn.textContent = i18n.t(text ? "panelEditDescription" : "panelAddDescription");
  }

  // --- save status the user can act on -------------------------------------

  // conflictMessage picks ONE whole sentence for the combination that was lost.
  // Sentences are never assembled from translated fragments: word order and
  // verb agreement differ per language ("was" / "were", "und"/"och"/"et").
  function conflictMessage(hasDesc, n) {
    if (hasDesc && n === 1) return i18n.t("saveConflictDescOne");
    if (hasDesc && n > 1) return i18n.t("saveConflictDescMany", { count: i18n.n(n) });
    if (hasDesc) return i18n.t("saveConflictDesc");
    if (n === 1) return i18n.t("saveConflictOne");
    if (n > 1) return i18n.t("saveConflictMany", { count: i18n.n(n) });
    return i18n.t("saveConflictGeneric");
  }

  function renderSavebar() {
    if (!panelEl) return;
    const bar = panelEl.querySelector(".ullabella-savebar");
    if (!bar) return;
    const text = panelEl.querySelector(".ullabella-savebar-text");
    const descEl = panelEl.querySelector(".ullabella-savebar-desc");
    const lostList = panelEl.querySelector(".ullabella-savebar-lost");
    const retry = panelEl.querySelector(".ullabella-savebar-retry");
    const readd = panelEl.querySelector(".ullabella-savebar-readd");
    const dismiss = panelEl.querySelector(".ullabella-savebar-dismiss");
    if (retry) retry.hidden = true;
    if (readd) readd.hidden = true;
    if (dismiss) dismiss.hidden = true;
    if (descEl) {
      descEl.hidden = true;
      descEl.textContent = "";
    }
    if (lostList) {
      lostList.innerHTML = "";
      lostList.hidden = true;
    }

    if (conflict) {
      const n = conflict.lost.length;
      const hasDesc = !!conflict.lostDescription;
      bar.hidden = false;
      bar.className = "ullabella-savebar ullabella-savebar-conflict";
      if (text) text.textContent = conflictMessage(hasDesc, n);
      if (descEl && hasDesc) {
        // The user's text, verbatim and selectable (never HTML, never lost).
        descEl.textContent = conflict.lostDescription;
        descEl.hidden = false;
      }
      if (lostList && n > 0) {
        lostList.hidden = false;
        conflict.lost.forEach(function (l) {
          const li = document.createElement("li");
          li.textContent = l.instruction; // text, not HTML — and selectable for copying
          lostList.appendChild(li);
        });
      }
      if (readd) {
        readd.hidden = false;
        readd.textContent = i18n.t(n === 1 && !hasDesc ? "panelReaddIt" : "panelReaddThem");
      }
      if (dismiss) dismiss.hidden = false;
      return;
    }

    bar.className = "ullabella-savebar";
    if (saveState === "unsaved") {
      bar.hidden = false;
      if (text) text.textContent = i18n.t("saveUnsaved");
      if (retry) retry.hidden = false;
      return;
    }
    bar.hidden = true;
  }

  function retrySave() {
    saveState = "saved";
    renderSavebar();
    persist();
  }

  function dismissConflict() {
    conflict = null;
    if (saveState === "refused") saveState = "saved";
    renderSavebar();
  }

  // readdLost is the explicit user action that puts refused work back into the
  // CURRENT session. Nothing is ever restored automatically.
  function readdLost() {
    if (!conflict || !session) return;
    const ts = new Date().toISOString();
    if (conflict.lostDescription) {
      session = sessionMod.withDescription(session, conflict.lostDescription);
    }
    const additions = conflict.lost.map(function (l) {
      return {
        annotationId: l.annotationId,
        instruction: l.instruction,
        target: l.target || {},
        createdAt: ts,
        updatedAt: ts,
      };
    });
    session = sessionMod.withAnnotations(session, queueList().concat(additions));
    for (const l of conflict.lost) {
      if (!l.target) continue;
      const el = findElement(l.target);
      if (el) anchors.set(l.annotationId, el);
    }
    conflict = null;
    saveState = "saved";
    persist();
    renderPanel();
    renderMarkers();
    setStatus("", "");
  }

  // --- first step: session description -------------------------------------

  // maybeShowIntro decides whether the "Session description" step is due. It is
  // shown once per session: an explicit Skip (or a saved description) is
  // recorded, and a session that already had annotations continues without it.
  function maybeShowIntro() {
    if (!session || !active) return;
    if (session.intro) return;
    if (queueList().length > 0) {
      session = sessionMod.withIntro(session, "existing");
      persist();
      return;
    }
    showIntro();
  }

  function showIntro() {
    if (introEl || !session) return;
    // Built node by node (no innerHTML): the copy is data, and the same pattern
    // keeps user text out of HTML everywhere in this file.
    const host = document.createElement("div");
    host.className = "ullabella-ui ullabella-intro-host";
    const card = document.createElement("div");
    card.className = "ullabella-intro-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "ullabella-intro-title");
    card.setAttribute("aria-describedby", "ullabella-intro-help");

    const title = document.createElement("h2");
    title.className = "ullabella-intro-title";
    title.setAttribute("id", "ullabella-intro-title");
    title.textContent = i18n.t("introTitle");

    const question = document.createElement("p");
    question.className = "ullabella-intro-question";
    question.textContent = i18n.t("introQuestion");

    const input = document.createElement("textarea");
    input.className = "ullabella-intro-input";
    input.setAttribute("rows", "4");
    input.setAttribute("maxlength", "2000");
    input.value = session.description || "";

    const help = document.createElement("p");
    help.className = "ullabella-intro-help";
    help.setAttribute("id", "ullabella-intro-help");
    help.textContent = i18n.t("introHelp");

    const actions = document.createElement("div");
    actions.className = "ullabella-actions";
    const skip = document.createElement("button");
    skip.className = "ullabella-intro-skip";
    skip.setAttribute("type", "button");
    skip.textContent = i18n.t("introSkip");
    const start = document.createElement("button");
    start.className = "ullabella-intro-start";
    start.setAttribute("type", "button");
    start.textContent = i18n.t("introStart");
    actions.appendChild(skip);
    actions.appendChild(start);

    card.appendChild(title);
    card.appendChild(question);
    card.appendChild(input);
    card.appendChild(help);
    card.appendChild(actions);
    host.appendChild(card);
    document.documentElement.appendChild(host);
    introEl = host;

    skip.addEventListener("click", function (e) {
      e.preventDefault();
      finishIntro("skipped");
    });
    start.addEventListener("click", function (e) {
      e.preventDefault();
      finishIntro("completed");
    });
    if (typeof input.focus === "function") input.focus();
  }

  // finishIntro records the answer. Whatever the user typed is kept even when
  // they skip — their text is never thrown away silently.
  function finishIntro(status) {
    if (!introEl || !session) {
      closeIntro();
      return;
    }
    const input = introEl.querySelector(".ullabella-intro-input");
    const text = (input && input.value ? input.value : "").trim();
    if (text) session = sessionMod.withDescription(session, text);
    session = sessionMod.withIntro(session, status);
    closeIntro();
    persist();
    ensurePanel();
    renderPanel();
    panelEl.classList.add("ullabella-open");
    updateClearButton();
    setStatus(status === "skipped" ? i18n.t("introSkipped") : "", "");
  }

  function closeIntro() {
    if (introEl && introEl.parentNode) introEl.parentNode.removeChild(introEl);
    introEl = null;
  }

  function openPanelForNew() {
    ensurePanel();
    panelEl.querySelector(".ullabella-summary").textContent = labelFor(selectedTarget);
    panelEl.querySelector(".ullabella-input").value = "";
    setStatus("", "");
    panelEl.classList.add("ullabella-open");
    renderPanel();
    panelEl.querySelector(".ullabella-input").focus();
  }

  function openPanelForEdit(a) {
    ensurePanel();
    panelEl.querySelector(".ullabella-summary").textContent = labelFor(a.target);
    panelEl.querySelector(".ullabella-input").value = a.instruction;
    setStatus("", "");
    panelEl.classList.add("ullabella-open");
    renderPanel();
    panelEl.querySelector(".ullabella-input").focus();
  }

  function labelFor(target) {
    const type = target && target.elementType ? target.elementType.toUpperCase() : i18n.t("elementFallback");
    if (target && target.visibleText) {
      return i18n.t("elementWithText", { type: type, text: target.visibleText });
    }
    return type;
  }

  function cancelSelection() {
    selectedElement = null;
    selectedTarget = null;
    editingId = null;
    clearArmed = false;
    if (panelEl) panelEl.classList.remove("ullabella-open");
    updateClearButton();
  }

  function removePanel() {
    if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    panelEl = null;
  }

  function setStatus(message, kind) {
    if (!panelEl) return;
    const status = panelEl.querySelector(".ullabella-status");
    status.textContent = message;
    status.className = "ullabella-status" + (kind ? " ullabella-" + kind : "");
  }

  // --- progress indicator (Hermes is working) -----------------------------

  let progressStartedAt = null;
  let progressLastChecked = null;
  let progressActivity = null; // latest { kind, activityAt, checkedAt } from the Relay
  let progressStatus = null;   // "accepted" | "working" | "paused"
  let progressTimer = null;

  function showProgress(status, msg) {
    if (!panelEl) return;
    const prog = panelEl.querySelector(".ullabella-progress");
    if (!prog) return;
    prog.hidden = false;
    if (msg && msg.startedAt) progressStartedAt = msg.startedAt;
    if (msg && msg.lastChecked) progressLastChecked = msg.lastChecked;
    if (msg && msg.activity) progressActivity = msg.activity;
    if (status) progressStatus = status;
    applyProgressLabels();
    setStatus("", "");
    updateProgress();
    if (!progressTimer) progressTimer = setInterval(updateProgress, 1000);
  }

  // applyProgressLabels writes the headline and the submitted count of the
  // progress block. It is kept apart from showProgress() so a language change can
  // relabel a running block without resetting the elapsed timer.
  function applyProgressLabels() {
    if (!panelEl) return;
    const prog = panelEl.querySelector(".ullabella-progress");
    if (!prog) return;
    const title = prog.querySelector(".ullabella-progress-title");
    if (title) {
      if (progressStatus === "paused") title.textContent = i18n.t("progressPaused");
      else if (progressActivity && progressActivity.kind === "waiting_for_approval") title.textContent = i18n.t("progressWaitingApproval");
      else if (progressStatus === "accepted") title.textContent = i18n.t("progressSending");
      else title.textContent = i18n.t("progressWorking");
    }
    const countEl = prog.querySelector(".ullabella-progress-count");
    if (countEl) {
      const job = currentJob();
      const submitted = job && Array.isArray(job.annotationIds) ? job.annotationIds.length : queueList().length;
      countEl.textContent = i18n.tn("progressSubmitted", submitted);
    }
  }

  function updateProgress() {
    if (!panelEl) return;
    const prog = panelEl.querySelector(".ullabella-progress");
    if (!prog || prog.hidden) return;
    if (progressStartedAt) {
      const s = Math.floor((Date.now() - progressStartedAt) / 1000);
      prog.querySelector(".ullabella-progress-elapsed").textContent = i18n.t("progressElapsed", { duration: fmtDuration(s) });
    }
    // Real agent activity: only what the Relay actually reported. When there is
    // no activity snapshot (or its kind is unknown) show a neutral state — never
    // invent intermediate activity.
    const activityEl = prog.querySelector(".ullabella-progress-activity");
    const label = progressActivity ? ub.activityLabel(progressActivity.kind, i18n.t) : null;
    activityEl.textContent = label
      ? i18n.t("progressActivity", { label: label })
      : i18n.t("progressActivityUnavailable");
    const agentEl = prog.querySelector(".ullabella-progress-agent");
    if (progressActivity && progressActivity.activityAt) {
      const t = Date.parse(progressActivity.activityAt);
      if (!isNaN(t)) {
        const s = Math.floor((Date.now() - t) / 1000);
        agentEl.textContent = i18n.t("progressLastActivity", { ago: i18n.ago(s) });
      }
    }
    if (progressLastChecked) {
      const s = Math.floor((Date.now() - progressLastChecked) / 1000);
      prog.querySelector(".ullabella-progress-checked").textContent =
        i18n.t("progressLastChecked", { ago: i18n.ago(s) });
    }
  }

  function hideProgress() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    progressStartedAt = null;
    progressLastChecked = null;
    progressActivity = null;
    progressStatus = null;
    if (panelEl) {
      const prog = panelEl.querySelector(".ullabella-progress");
      if (prog) prog.hidden = true;
    }
  }

  function fmtDuration(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return (m < 10 ? "0" : "") + m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  function showDone() {
    if (queueList().length === 0) {
      setStatus(i18n.t("statusNoAnnotations"), "");
      return;
    }
    const r = rollup(queueList());
    const kind = r.done === r.total ? "done" : (r.failed > 0 ? "error" : "");
    setStatus(rollupSummary(queueList()), kind);
  }

  function rollup(list) {
    let done = 0;
    let failed = 0;
    let unknown = 0;
    for (const a of list) {
      const s = a.result && a.result.status;
      if (s === "done") done++;
      else if (s === "error") failed++;
      else unknown++;
    }
    return { done: done, failed: failed, unknown: unknown, total: list.length };
  }

  function rollupSummary(list) {
    const r = rollup(list);
    if (r.done === r.total) {
      return i18n.t("rollupAllDone", { done: i18n.n(r.done), total: i18n.n(r.total) });
    }
    if (r.done === 0 && r.failed === 0) {
      return i18n.tn("rollupUnavailable", r.total);
    }
    const parts = [];
    if (r.done > 0) parts.push(i18n.t("rollupPartDone", { count: i18n.n(r.done) }));
    if (r.failed > 0) parts.push(i18n.t("rollupPartFailed", { count: i18n.n(r.failed) }));
    if (r.unknown > 0) parts.push(i18n.tn("rollupPartUnknown", r.unknown));
    return parts.join(" · ");
  }

  function terminal() {
    const job = currentJob();
    return !!(job && (job.status === "done" || job.status === "error" || job.status === "uncertain"));
  }

  function resultMark(a) {
    const r = a.result;
    if (!r) return { cls: "", label: null };
    switch (r.status) {
      case "processing": return { cls: "ullabella-processing", label: null };
      case "done": return { cls: "ullabella-done", label: "\u2713" };
      case "error": return { cls: "ullabella-error", label: "\u2717" };
      default: return { cls: "ullabella-unknown", label: "?" };
    }
  }

  function resultTitle(a) {
    const r = a.result;
    if (!r) return "";
    switch (r.status) {
      case "done":
        return r.summary ? i18n.t("resultDoneSummary", { summary: r.summary }) : i18n.t("resultDone");
      // An error message from the Relay/adapter/Hermes is service DATA (the
      // reason the agent gave), not extension copy: it is shown as it arrived.
      case "error": return r.error && r.error.message ? r.error.message : i18n.t("resultFailed");
      case "unknown": return i18n.t("resultUnknown");
      default: return i18n.t("resultProcessing");
    }
  }

  function showDetail(a) {
    if (!panelEl) return;
    const text = a.instruction;
    const r = a.result;
    let line;
    if (!r || r.status === "processing") {
      line = i18n.t("detailProcessing", { text: text });
    } else if (r.status === "done") {
      line = r.summary
        ? i18n.t("detailDoneSummary", { text: text, summary: r.summary })
        : i18n.t("detailDone", { text: text });
    } else if (r.status === "error") {
      line = r.error && r.error.message
        ? i18n.t("detailFailedReason", { text: text, reason: r.error.message })
        : i18n.t("detailFailed", { text: text });
    } else {
      line = i18n.t("detailUnknownStatus", { text: text });
    }
    panelEl.querySelector(".ullabella-summary").textContent = line;
  }

  function showError(error) {
    setStatus(i18n.t("errorPrefix", { message: friendlyError(error) }), "error");
    const add = panelEl.querySelector(".ullabella-add");
    if (add) add.disabled = false;
    const send = panelEl.querySelector(".ullabella-send");
    if (send) send.disabled = false;
  }

  function friendlyError(err) {
    const e = err || {};
    switch (e.code) {
      case "agent_unavailable":
        return i18n.t("errAgentUnavailable");
      case "hermes_unavailable":
      case "hermes_outcome_unparseable":
        return i18n.t("errEditorUnavailable");
      case "mcp_unconfigured":
        return i18n.t("errToolNotSetUp");
      case "relay_unreachable":
        return i18n.t("errServiceUnreachable");
      case "timeout":
        return i18n.t("errTimeout");
      case "relay_restarted":
      case "delivery_uncertain":
        return i18n.t("errOutcomeUncertain");
      case "site_not_configured":
        return i18n.t("errNotConnectedForEditing");
      case "site_disabled":
        return i18n.t("errSiteUnavailable");
      case "url_out_of_origin":
        return i18n.t("errOutsideSite");
      case "path_out_of_workspace":
        return i18n.t("errElementUnmatched");
      case "verification_failed":
        return i18n.t("errNotConfirmed");
      case "edit_failed":
        return i18n.t("errEditFailed");
      case "device_out_of_scope":
      case "device_mismatch":
      case "invalid_credential":
        return i18n.t("errNotAuthorized");
      case "job_conflict":
        return i18n.t("errRequestConflict");
      case "extension_unavailable":
        return i18n.t("errExtensionUnavailable");
      default:
        // The code is the diagnosis. A free-text message from a service is data
        // of unknown language, so it is never shown as if it were UI copy.
        return e.code ? i18n.t("errUnexpected", { code: e.code }) : i18n.t("errUnexpectedNoCode");
    }
  }

  // --- send ----------------------------------------------------------------

  function sendAll() {
    if (busy || queueList().length === 0 || !session || !connection) return;
    busy = true;
    clearArmed = false;
    setStatus(i18n.tn("statusSending", queueList().length), "working");
    panelEl.querySelector(".ullabella-send").disabled = true;

    const annotations = queueList().map(function (a) {
      return ub.buildAnnotation(a.instruction, a.target, a.annotationId);
    });
    // The session description travels as job-wide context, exactly as it is at
    // submit time: later edits apply to the NEXT submission, never to this one.
    const description = (session.description || "").trim();
    const job = ub.buildJob(
      { siteId: connection.siteId, deviceId: connection.deviceId },
      annotations,
      { session: description }
    );
    // The chosen agent travels with the job; the Relay validates it against the
    // site's grants and never falls back to another agent.
    const agentId = connection.agentId || "";
    if (agentId) job.agentId = agentId;

    // The round is pinned to the connection/relay/agent it was submitted to, so
    // switching settings later cannot re-route it or mix its results into
    // another session.
    session = sessionMod.withJob(session, {
      jobId: job.jobId,
      status: "sending",
      siteId: connection.siteId,
      connectionId: connection.connectionId,
      origin: connection.origin,
      relayUrl: connection.relayUrl,
      agentId: agentId,
      sessionKey: sessKey,
      submittedAt: new Date().toISOString(),
      annotationIds: annotations.map(function (a) {
        return a.annotationId;
      }),
      sessionDescription: description,
    });
    session = sessionMod.withAnnotations(session, q.markProcessing(queueList()));
    persist();

    chrome.runtime.sendMessage(
      { type: "submitJob", job: job, sessionKey: sessKey, connectionId: connection.connectionId },
      (resp) => {
      if (chrome.runtime.lastError) {
        busy = false;
        session = sessionMod.withJob(session, Object.assign({}, currentJob(), { status: "error" }));
        persist();
        renderPanel();
        showError({ code: "extension_unavailable" });
        return;
      }
      if (resp && resp.ok === false) {
        busy = false;
        session = sessionMod.withJob(session, Object.assign({}, currentJob(), { status: "error" }));
        persist();
        renderPanel();
        showError(resp.error);
        return;
      }
      // Success: the terminal state (done/error) arrives via the ubJobStatus
      // messages the background worker pushes while polling. This callback fires
      // only after that terminal status was already sent, so it must not touch
      // the panel here (setting "Working" again would clobber "Done").
    });
  }

  function resumeJob(jobId) {
    busy = true;
    setStatus(i18n.t("statusResuming"), "working");
    chrome.runtime.sendMessage(
      {
        type: "resumePoll",
        jobId: jobId,
        sessionKey: sessKey,
        connectionId: connection ? connection.connectionId : null,
      },
      () => {
        // status arrives via ubJobStatus
      }
    );
  }

  // resultsFor decides which per-annotation results a terminal round carries.
  // A round with exactly ONE annotation comes back with the job-level outcome
  // only (the adapter reports annotationResults for batches), so that annotation
  // takes the job's own verified result instead of being shown as unknown. A
  // batch without per-annotation results is left to applyResults, which marks it
  // unknown — the extension never invents a per-annotation outcome.
  function resultsFor(msg, job) {
    const list = msg.annotationResults;
    if (Array.isArray(list) && list.length > 0) return list;
    const ids = job && Array.isArray(job.annotationIds) ? job.annotationIds.filter(Boolean) : [];
    if (msg.status !== "done" || ids.length !== 1) return list;
    return [{ annotationId: ids[0], status: "done", summary: msg.summary, verification: msg.verification }];
  }

  function onStatus(msg) {
    if (!session) return;
    // Isolation: a status belongs to one session and one round only.
    if (msg.sessionKey && sessKey && msg.sessionKey !== sessKey) return;
    const job = currentJob();
    if (msg.jobId && job && job.jobId && msg.jobId !== job.jobId) return;
    if (!panelEl) return;

    if (msg.status === "done") {
      hideProgress();
      busy = false;
      session = sessionMod.withAnnotations(session, q.applyResults(queueList(), resultsFor(msg, job)));
      session = sessionMod.withJob(session, Object.assign({}, job || {}, {
        jobId: msg.jobId || (job && job.jobId) || null,
        status: "done",
        finishedAt: new Date().toISOString(),
      }));
      persist();
      renderPanel();
      renderMarkers();
      showDone();
    } else if (msg.status === "error") {
      hideProgress();
      busy = false;
      const code = msg.error && msg.error.code;
      const uncertain = code === "relay_restarted" || code === "delivery_uncertain";
      if (uncertain) {
        session = sessionMod.withAnnotations(session, q.markUncertain(queueList()));
      }
      session = sessionMod.withJob(session, Object.assign({}, job || {}, {
        jobId: msg.jobId || (job && job.jobId) || null,
        status: uncertain ? "uncertain" : "error",
        finishedAt: new Date().toISOString(),
      }));
      persist();
      renderPanel();
      renderMarkers();
      showError(msg.error);
    } else if (msg.status === "working" || msg.status === "accepted") {
      // Display-only: "processing" is not persisted (the terminal status is),
      // so it must not bump the session revision.
      session = Object.assign({}, session, { annotations: q.markProcessing(queueList()) });
      renderMarkers();
      showProgress(msg.status, msg);
    } else if (msg.status === "paused") {
      showProgress("paused", msg);
    }
  }

  // --- language change -----------------------------------------------------

  // relocalize re-labels everything this tab currently shows, without touching
  // what the user typed. Chrome-driven surfaces (the toolbar menu, the extension
  // name in Chrome) follow the browser language and are not affected — the
  // settings note says so.
  function relocalize() {
    if (!active) return;
    applyPanelLabels();
    if (commentForId) {
      const id = commentForId;
      const anchor = commentAnchor;
      closeComment();
      openComment(id, anchor);
    }
    if (introEl) {
      const typed = introEl.querySelector(".ullabella-intro-input");
      const value = typed && typeof typed.value === "string" ? typed.value : "";
      closeIntro();
      showIntro();
      const next = introEl && introEl.querySelector(".ullabella-intro-input");
      if (next && value) next.value = value;
    }
    renderPanel();
    renderMarkers();
    const progress = panelEl && panelEl.querySelector(".ullabella-progress");
    if (progress && !progress.hidden) {
      applyProgressLabels();
      updateProgress();
    }
  }

  // --- cross-tab convergence ----------------------------------------------

  // Another context (tab) wrote this session: adopt its tombstones and merge
  // what it added, so both tabs show the same queue. Never writes back.
  if (chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      // Settings changed: another connection may now serve this page (or one
      // stopped serving it). Re-resolve for THIS tab and, if the connection
      // actually changed, reload the session for the new key.
      // The language choice is applied in place: panel, markers and an open
      // popover are relabelled, so no reload is needed.
      if (changes[i18n.LANG_KEY]) {
        i18n.setLanguage(changes[i18n.LANG_KEY].newValue);
        relocalize();
        return;
      }
      if (changes[conns.STORE_KEY] || changes[conns.ACTIVE_KEY] || changes[conns.REMOVED_KEY]) {
        resyncConnection();
        return;
      }
      if (!sessKey || !session) return;
      const change = changes[sessKey];
      if (!change || !change.newValue) return;
      applySession(sessionMod.reconcile(session, change.newValue));
    });
  }

  // resyncConnection re-resolves this tab after a settings change. Open editor
  // text is preserved: switching connections never clears the description
  // editor or the instruction box.
  let resyncQueued = false;
  function resyncConnection() {
    if (resyncQueued) return;
    resyncQueued = true;
    Promise.resolve().then(async function () {
      resyncQueued = false;
      const previousId = connection ? connection.connectionId : null;
      sitePromise = null;
      const next = await resolveConnection();
      if (!next) {
        // The page is no longer connected (or became ambiguous): leave editing
        // mode rather than keep writing into a session this tab no longer owns.
        if (active) exit();
        return;
      }
      if (next.connectionId === previousId) {
        if (active) {
          renderPanel();
          renderMarkers();
        }
        return;
      }
      if (!active) return;
      // Different connection: this tab may hold unsaved editor text, so only the
      // session document is swapped — the panel inputs are left alone.
      closeComment();
      conflict = null;
      saveState = "saved";
      await restore();
      renderMarkers();
      renderPanel();
      const job = currentJob();
      if (job && job.jobId && (job.status === "sending" || job.status === "submitted")) {
        resumeJob(job.jobId);
      }
    });
  }

  // Announce presence once resolved, so the service worker turns the toolbar
  // icon active (green) on a connected page. Best-effort; any failure is harmless.
  resolveConnection().then(function (conn) {
    if (conn) {
      try {
        console.log("[Ulla-Bella] content script active on " + conn.origin + ", signaling ubActive");
        chrome.runtime.sendMessage({ type: "ubActive" });
      } catch (_) {}
    }
  });
})();
