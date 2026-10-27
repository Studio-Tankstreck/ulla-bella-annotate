// Ulla-Bella Extension — UI language resolution.
//
// TRANSLATIONS live in extension/_locales/<lang>/messages.json — Chrome's own
// i18n format, the file Chrome itself reads for the manifest strings
// (name / description / action title, see default_locale in manifest.json).
// scripts/build-i18n.py bundles those files into src/i18n-messages.js.
//
// WHY THIS MODULE EXISTS: chrome.i18n.getMessage() always answers in the
// BROWSER UI language and Chrome offers no way to override it per extension
// (chrome.i18n has no language setter; the ?lang= override is for tests only).
// A manual choice stored with the extension's settings could therefore never
// take effect through chrome.i18n. So the extension resolves the language itself
// — stored choice → browser language → English — and answers from the bundled
// data, synchronously, in every context (popup, content script, service worker).
//
// WHAT STAYS ON THE BROWSER LANGUAGE: the surfaces Chrome drives from the
// manifest (extension name, description, the toolbar button's menu label, the
// Web Store listing, permission prompts, chrome://extensions, the "extension
// updated" bubble). Those cannot follow a manual choice; docs/I18N.md says so
// and the settings note tells the user the same.
//
// ENGLISH IS THE FALLBACK for every missing translation, and en is complete by
// construction (i18n.test.js pins key parity across all nine files), so a label
// is never empty and never shows an internal key.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.UllaBellaI18n = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const DEFAULT_LANGUAGE = "en";
  const AUTO = "auto";
  // The stored key holds AUTO or one of SUPPORTED. It lives in
  // chrome.storage.local, written by the service worker (message "setLanguage"),
  // which is the same single-writer path the rest of the settings use.
  const LANG_KEY = "ub.language";

  // Chrome locale codes, not language names: these are the _locales directory
  // names. "nb" is Norwegian bokmål (Chrome ships no "no").
  const SUPPORTED = ["en", "sv", "de", "es", "it", "nl", "nb", "da", "fi"];

  // Endonyms: a language option is written in ITS OWN language, so a user who
  // cannot read the current interface still finds their language. These are not
  // translated strings — the label for Swedish is "Svenska" in every locale.
  const LANGUAGES = [
    { code: "en", label: "English" },
    { code: "sv", label: "Svenska" },
    { code: "de", label: "Deutsch" },
    { code: "es", label: "Español" },
    { code: "it", label: "Italiano" },
    { code: "nl", label: "Nederlands" },
    { code: "nb", label: "Norsk bokmål" },
    { code: "da", label: "Dansk" },
    { code: "fi", label: "Suomi" },
  ];

  // Language tags a browser may report that map onto a supported locale.
  const ALIASES = { no: "nb", nn: "nb", iw: "he" };

  let dataset = null;   // the bundled { lang: { key: message } } map
  let current = DEFAULT_LANGUAGE;

  // messages() lazily picks up the bundled data: require() under node (tests),
  // the global under Chrome. In the browser it is NOT cached while the bundle is
  // still missing, so an injection order change cannot freeze an empty map.
  function messages() {
    if (dataset) return dataset;
    if (typeof module === "object" && module.exports) {
      dataset = require("./i18n-messages.js");
      return dataset;
    }
    const bundled = root && root.UllaBellaMessages;
    if (!bundled) return {};
    dataset = bundled;
    return dataset;
  }

  // setDataset lets a test (or a future remote pack) supply its own map. It is
  // also how a missing-key fallback can be exercised deterministically.
  function setDataset(map) {
    dataset = map || null;
  }

  function baseLanguage(tag) {
    const raw = typeof tag === "string" ? tag.trim().toLowerCase() : "";
    if (!raw) return "";
    const base = raw.split(/[-_]/)[0];
    return ALIASES[base] || base;
  }

  // normalizeChoice maps a stored value onto AUTO or a supported code. Anything
  // unrecognized (a hand-edited store, a removed language) is treated as AUTO
  // rather than showing a half-translated interface.
  function normalizeChoice(value) {
    const v = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!v || v === AUTO) return AUTO;
    if (SUPPORTED.indexOf(v) !== -1) return v;
    const base = baseLanguage(v);
    return SUPPORTED.indexOf(base) !== -1 ? base : AUTO;
  }

  // resolveLanguage is the whole rule, in one pure function:
  //   manual choice  → that language (always supported, English if unknown)
  //   Automatic      → the browser's language when supported, else English
  function resolveLanguage(choice, uiLanguage) {
    const picked = normalizeChoice(choice);
    if (picked !== AUTO) return picked;
    const base = baseLanguage(uiLanguage);
    return SUPPORTED.indexOf(base) !== -1 ? base : DEFAULT_LANGUAGE;
  }

  // uiLanguage reads the browser's UI language, which is also what Chrome uses
  // to pick _locales/<lang>. Absent (node tests, exotic context) → "".
  function uiLanguage() {
    try {
      if (typeof chrome !== "undefined" && chrome && chrome.i18n &&
          typeof chrome.i18n.getUILanguage === "function") {
        return chrome.i18n.getUILanguage() || "";
      }
    } catch (_) {
      // no chrome.i18n here
    }
    return "";
  }

  // setLanguage activates a language. Callers pass the stored choice; tests pass
  // an explicit browser language so the rule is deterministic.
  function setLanguage(choice, browserLanguage) {
    current = resolveLanguage(choice, browserLanguage === undefined ? uiLanguage() : browserLanguage);
    return current;
  }

  // loadChoice is the one read path every context uses: read the stored choice,
  // activate it, answer with the language that is now in effect.
  async function loadChoice(storage) {
    let raw = null;
    try {
      const got = storage ? await storage.get(LANG_KEY) : null;
      raw = got ? got[LANG_KEY] : null;
    } catch (_) {
      raw = null;
    }
    return setLanguage(raw);
  }

  function language() {
    return current;
  }

  function languageLabel(code) {
    for (const l of LANGUAGES) {
      if (l.code === code) return l.label;
    }
    return DEFAULT_LANGUAGE === code ? "English" : code;
  }

  function lookup(lang, key) {
    const table = messages()[lang];
    if (!table) return null;
    const value = table[key];
    return typeof value === "string" && value !== "" ? value : null;
  }

  function warn(key) {
    try {
      if (typeof console !== "undefined" && console && console.warn) {
        console.warn("[Ulla-Bella] missing translation key: " + key);
      }
    } catch (_) {
      // console unavailable
    }
  }

  // interpolate replaces $NAME$ placeholders from params (case-insensitive).
  // A placeholder with no value is left as-is instead of turning into
  // "undefined" — i18n.test.js pins that every call site supplies them.
  function interpolate(message, params) {
    if (!params) return message;
    return String(message).replace(/\$([A-Za-z0-9_]+)\$/g, function (whole, name) {
      if (Object.prototype.hasOwnProperty.call(params, name)) return String(params[name]);
      const lower = name.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(params, lower)) return String(params[lower]);
      return whole;
    });
  }

  // t resolves one key: active language → English → "" (plus a console warning;
  // unreachable for any key that exists, which the tests enforce).
  function t(key, params) {
    if (!key) return "";
    const value = lookup(current, key) || lookup(DEFAULT_LANGUAGE, key);
    if (value == null) {
      warn(key);
      return "";
    }
    return interpolate(value, params);
  }

  function pluralCategory(count) {
    try {
      return new Intl.PluralRules(current).select(Number(count));
    } catch (_) {
      return Number(count) === 1 ? "one" : "other";
    }
  }

  // n formats a number in the active locale (grouping, digits).
  function n(value) {
    try {
      return new Intl.NumberFormat(current).format(value);
    } catch (_) {
      return String(value);
    }
  }

  // tn resolves a plural key: <key>_<category> → <key>_other → <key>. The count
  // is passed as $COUNT$ already formatted for the locale. Plural categories are
  // chosen by Intl.PluralRules, so a language that later needs "few"/"many"
  // only needs the extra keys, not a code change.
  function tn(key, count, params) {
    const merged = Object.assign({ count: n(count) }, params || {});
    const candidates = [key + "_" + pluralCategory(count), key + "_other", key];
    for (const candidate of candidates) {
      const value = lookup(current, candidate) || lookup(DEFAULT_LANGUAGE, candidate);
      if (value != null) return interpolate(value, merged);
    }
    warn(key);
    return "";
  }

  // ago formats "N seconds ago" in the active locale ("just now" for 0). It uses
  // Intl.RelativeTimeFormat instead of a "$COUNT$s ago" template so word order,
  // plural forms and even the separator come from the locale, not from us.
  function ago(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    try {
      return new Intl.RelativeTimeFormat(current, { numeric: "auto" }).format(-s, "second");
    } catch (_) {
      return s === 0 ? "0 s" : "-" + s + " s";
    }
  }

  return {
    DEFAULT_LANGUAGE: DEFAULT_LANGUAGE,
    AUTO: AUTO,
    LANG_KEY: LANG_KEY,
    SUPPORTED: SUPPORTED,
    LANGUAGES: LANGUAGES,
    baseLanguage: baseLanguage,
    normalizeChoice: normalizeChoice,
    resolveLanguage: resolveLanguage,
    uiLanguage: uiLanguage,
    setLanguage: setLanguage,
    loadChoice: loadChoice,
    language: language,
    languageLabel: languageLabel,
    setDataset: setDataset,
    t: t,
    tn: tn,
    n: n,
    ago: ago,
  };
});
