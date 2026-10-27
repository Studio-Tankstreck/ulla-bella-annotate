// Ulla-Bella Extension — job-monitoring helpers (pure, no chrome.*).
//
// The polling state machine is kept free of chrome.* so it can be unit-tested
// with an injected fetch. The service worker (background.js) wires these into
// chrome.storage / chrome.alarms / chrome.action; this module never touches them.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.UllaBellaMonitor = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const POLL_INTERVAL_MS = 500;
  const HEARTBEAT_INTERVAL_MS = 5000;

  // isTerminal reports whether a job status is final (done or error).
  function isTerminal(status) {
    return status === "done" || status === "error";
  }

  // isUncertain reports whether a job status means "outcome unknown" (the user
  // must review the page). Only the relay's explicit uncertainty counts here.
  function isUncertain(status) {
    return status === "uncertain";
  }

  // badgeFor maps a job status to the toolbar badge text. An empty string
  // clears the badge.
  function badgeFor(status) {
    switch (status) {
      case "accepted":
      case "working":
      case "paused":
        return "…";
      case "done":
        return "✓";
      case "error":
        return "!";
      case "uncertain":
        return "?";
      default:
        return "";
    }
  }

  // titleFor maps a job status to the toolbar tooltip. `t` is the caller's
  // translator (i18n.t); the tooltip is the one translated surface the service
  // worker owns, so the copy lives in the locale files.
  function titleFor(status, t) {
    switch (status) {
      case "accepted": return t("toolbarSending");
      case "working": return t("toolbarWorking");
      case "paused": return t("toolbarPaused");
      case "done": return t("toolbarDone");
      case "error": return t("toolbarFailed");
      case "uncertain": return t("toolbarUncertain");
      default: return t("toolbarIdle");
    }
  }

  // pollOnce fetches one job status from the Relay. Returns:
  //   { transient: true, code }                    — a network/parse failure to retry later
  //   { transient: false, status, payload }        — a successful poll
  // A transient failure is deliberately NOT a job failure: the caller should
  // pause active polling and resume later (the job keeps running server-side).
  function pollOnce(fetchFn, relayUrl, authHeaders, jobId) {
    return fetchFn(relayUrl + "/v1/jobs/" + jobId, { headers: authHeaders }).then(
      function (resp) {
        return resp.json().then(
          function (body) {
            const payload = (body && body.payload) || {};
            return { transient: false, status: payload.status || null, payload: payload };
          },
          function () {
            return { transient: false, status: null, payload: {} };
          }
        );
      },
      function () {
        return { transient: true, code: "relay_unreachable" };
      }
    );
  }

  return {
    POLL_INTERVAL_MS: POLL_INTERVAL_MS,
    HEARTBEAT_INTERVAL_MS: HEARTBEAT_INTERVAL_MS,
    isTerminal: isTerminal,
    isUncertain: isUncertain,
    badgeFor: badgeFor,
    titleFor: titleFor,
    pollOnce: pollOnce,
  };
});
