"use strict";

// Guards for the translation layer.
//
// What this file pins:
//   1. all nine locale files exist and carry the SAME keys (key parity);
//   2. every $PLACEHOLDER$ is identical across languages and declared in
//      "placeholders" (so a message can never be silently broken);
//   3. the bundled src/i18n-messages.js is exactly the _locales content
//      (the generator can never drift);
//   4. the manifest's __MSG_*__ keys resolve in every locale, and default_locale
//      is English;
//   5. every key the extension source references exists (a typo fails the suite
//      instead of showing an empty label), and no key is dead;
//   6. the resolution rules: automatic / manual / English fallback / plural /
//      number and relative-time formatting.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const EXT = path.join(__dirname, "..");
const SRC = path.join(EXT, "src");
const LOCALES = path.join(EXT, "_locales");
const i18n = require(path.join(SRC, "i18n.js"));
const bundled = require(path.join(SRC, "i18n-messages.js"));

const LANGS = i18n.SUPPORTED;
const PLACEHOLDER = /\$([A-Za-z0-9_]+)\$/g;

function locale(lang) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES, lang, "messages.json"), "utf8"));
}

function placeholdersIn(message) {
  const found = new Set();
  let match;
  PLACEHOLDER.lastIndex = 0;
  while ((match = PLACEHOLDER.exec(message))) found.add(match[1]);
  return found;
}

function sortedKeys(object) {
  return Object.keys(object).sort();
}

// Runs fn with `lang` active and restores the previous language afterwards:
// node --test shares one module instance across the tests in this file.
function withLang(lang, fn) {
  const previous = i18n.language();
  i18n.setLanguage(lang, "en-US");
  try {
    return fn();
  } finally {
    i18n.setLanguage(previous, "en-US");
  }
}

// --- locale files ----------------------------------------------------------

test("every supported language has a messages.json, and only those exist", () => {
  const dirs = fs
    .readdirSync(LOCALES)
    .filter((name) => fs.statSync(path.join(LOCALES, name)).isDirectory())
    .sort();
  assert.deepEqual(dirs, LANGS.slice().sort(), "_locales must hold exactly the supported languages");
  for (const lang of LANGS) {
    assert.ok(fs.existsSync(path.join(LOCALES, lang, "messages.json")), "missing " + lang);
  }
});

test("all locale files carry exactly the same keys as English", () => {
  const english = sortedKeys(locale("en"));
  assert.ok(english.length > 100, "English should be the complete source of copy");
  for (const lang of LANGS) {
    if (lang === "en") continue;
    const table = locale(lang);
    const missing = english.filter((key) => !(key in table));
    const extra = sortedKeys(table).filter((key) => !english.includes(key));
    assert.deepEqual(missing, [], lang + " is missing keys");
    assert.deepEqual(extra, [], lang + " has keys English does not have");
  }
});

test("no message is empty or merely repeats its own key", () => {
  const english = sortedKeys(locale("en"));
  for (const lang of LANGS) {
    const table = locale(lang);
    for (const key of english) {
      const message = table[key].message;
      assert.equal(typeof message, "string", lang + "/" + key + " is not text");
      assert.ok(message.trim() !== "", lang + "/" + key + " is empty");
      assert.notEqual(message, key, lang + "/" + key + " shows the internal key");
    }
  }
});

test("placeholders match across languages and are declared for Chrome", () => {
  const english = locale("en");
  for (const key of sortedKeys(english)) {
    const expected = [...placeholdersIn(english[key].message)].sort();
    for (const lang of LANGS) {
      const entry = locale(lang)[key];
      const found = [...placeholdersIn(entry.message)].sort();
      assert.deepEqual(found, expected, lang + "/" + key + " uses different placeholders");
      const declared = entry.placeholders || {};
      assert.deepEqual(
        Object.keys(declared).sort(),
        expected.map((token) => token.toLowerCase()).sort(),
        lang + "/" + key + " must declare every placeholder"
      );
      for (const token of expected) {
        const slot = declared[token.toLowerCase()];
        assert.ok(slot && /^\$\d+$/.test(slot.content), lang + "/" + key + " placeholder " + token);
      }
    }
  }
});

test("plural keys come in complete one/other pairs", () => {
  const keys = sortedKeys(locale("en"));
  for (const key of keys) {
    if (key.endsWith("_one")) {
      assert.ok(keys.includes(key.slice(0, -4) + "_other"), key + " has no _other form");
    } else if (key.endsWith("_other")) {
      assert.ok(keys.includes(key.slice(0, -6) + "_one"), key + " has no _one form");
    }
  }
});

test("the bundled module is exactly the locale files (run scripts/build-i18n.py)", () => {
  const expected = {};
  for (const lang of LANGS) {
    const table = locale(lang);
    expected[lang] = {};
    for (const key of sortedKeys(table)) expected[lang][key] = table[key].message;
  }
  assert.deepEqual(bundled, expected);
});

// --- manifest --------------------------------------------------------------

test("the manifest localises its own strings and defaults to English", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  assert.equal(manifest.default_locale, "en", "default_locale must be en");
  const used = JSON.stringify(manifest).match(/__MSG_([A-Za-z0-9_]+)__/g) || [];
  assert.ok(used.length >= 3, "name, description and the action title are localised");
  const keys = new Set(used.map((token) => token.slice(6, -2)));
  for (const key of keys) {
    for (const lang of LANGS) {
      assert.ok(locale(lang)[key], "manifest key " + key + " missing in " + lang);
    }
  }
});

// --- source references -----------------------------------------------------

// Keys referenced from JS: anything quoted inside a t( / tn( call, including the
// two branches of a conditional (i18n.t(cond ? "a" : "b")), plus data-i18n in the
// popup markup.
function referencedKeys() {
  const keys = new Set();
  // The first argument only: a trailing `, "error")` belongs to the caller, not
  // to the translator.
  const call = /(?:\bt|\bi18n\.t|\bi18n\.tn)\(\s*([^,;\n]*)/g;
  const literal = /"([A-Za-z][A-Za-z0-9_]*)"/g;
  for (const file of fs.readdirSync(SRC).filter((name) => name.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(SRC, file), "utf8");
    let match;
    while ((match = call.exec(text))) {
      let literalMatch;
      literal.lastIndex = 0;
      while ((literalMatch = literal.exec(match[1]))) keys.add(literalMatch[1]);
    }
  }
  const html = fs.readFileSync(path.join(SRC, "popup.html"), "utf8");
  let attr;
  const attribute = /data-i18n="([A-Za-z][A-Za-z0-9_]*)"/g;
  while ((attr = attribute.exec(html))) keys.add(attr[1]);
  return keys;
}

// A plural key is referenced by its base name: tn("progressSubmitted", n)
// resolves progressSubmitted_one / _other.
function isReferenced(key, used) {
  if (used.has(key)) return true;
  return /_(one|other)$/.test(key) && used.has(key.replace(/_(one|other)$/, ""));
}

test("every key the source references exists in English", () => {
  const english = locale("en");
  const unknown = [...referencedKeys()].filter(
    (key) => !(key in english) && !(key + "_other" in english)
  );
  assert.deepEqual(unknown.sort(), [], "unknown translation keys: " + unknown.join(", "));
});

test("no locale key is dead (every key is used, except the manifest ones)", () => {
  const manifestOnly = new Set(["extName", "extDescription", "actionTitle"]);
  const used = referencedKeys();
  const dead = sortedKeys(locale("en")).filter((key) => !isReferenced(key, used) && !manifestOnly.has(key));
  assert.deepEqual(dead, [], "unused translation keys: " + dead.join(", "));
});

// --- resolution ------------------------------------------------------------

test("automatic follows the browser language and falls back to English", () => {
  assert.equal(i18n.resolveLanguage("auto", "sv-SE"), "sv");
  assert.equal(i18n.resolveLanguage("auto", "de"), "de");
  assert.equal(i18n.resolveLanguage("auto", "fi-FI"), "fi");
  assert.equal(i18n.resolveLanguage("auto", "nb-NO"), "nb");
  assert.equal(i18n.resolveLanguage("auto", "no-NO"), "nb", "Chrome reports Norwegian as nb/no");
  assert.equal(i18n.resolveLanguage("auto", "th-TH"), "en", "unsupported → English");
  assert.equal(i18n.resolveLanguage("auto", ""), "en");
  assert.equal(i18n.resolveLanguage(undefined, undefined), "en");
  assert.equal(i18n.resolveLanguage("", "da-DK"), "da");
});

test("a manual choice wins over the browser language, consistently", () => {
  assert.equal(i18n.resolveLanguage("de", "sv-SE"), "de");
  assert.equal(i18n.resolveLanguage("fi", "en-US"), "fi");
  assert.equal(i18n.resolveLanguage("sv-SE", "en-US"), "sv", "a stored tag is normalized");
  assert.equal(i18n.resolveLanguage("nb", "en-US"), "nb");
  // An unrecognized stored value is treated as Automatic, never half-translated.
  assert.equal(i18n.resolveLanguage("th", "sv-SE"), "sv");
});

test("the stored choice round-trips through chrome.storage", async () => {
  const store = { [i18n.LANG_KEY]: "da" };
  const storage = { get: async (key) => ({ [key]: store[key] }) };
  assert.equal(await i18n.loadChoice(storage), "da");
  assert.equal(i18n.language(), "da");

  // "Automatic" re-derives from the browser's UI language on every load.
  globalThis.chrome = { i18n: { getUILanguage: () => "it-IT" } };
  try {
    assert.equal(await i18n.loadChoice({ get: async () => ({}) }), "it", "no stored choice → automatic");
  } finally {
    delete globalThis.chrome;
  }
  i18n.setLanguage("en", "en-US");
});

test("every supported language resolves its own copy with no key left behind", () => {
  const english = sortedKeys(locale("en"));
  for (const lang of LANGS) {
    withLang(lang, () => {
      assert.equal(i18n.language(), lang);
      for (const key of english) {
        assert.equal(i18n.t(key), bundled[lang][key], lang + " did not resolve " + key);
      }
    });
  }
});

test("a missing translation falls back to English, never to a key or an empty label", () => {
  i18n.setDataset({ en: bundled.en, sv: {} });
  try {
    i18n.setLanguage("sv", "sv-SE");
    assert.equal(i18n.t("panelSendAll"), bundled.en.panelSendAll);
    assert.equal(i18n.tn("progressSubmitted", 2), "2 annotations submitted");
  } finally {
    i18n.setDataset(bundled);
    i18n.setLanguage("en", "en-US");
  }
});

test("placeholders, plurals, numbers and relative time follow the language", () => {
  withLang("de", () => {
    assert.equal(i18n.tn("progressSubmitted", 1), "1 Anmerkung gesendet");
    assert.equal(i18n.tn("progressSubmitted", 3), "3 Anmerkungen gesendet");
    assert.equal(i18n.t("panelClearTitle", { session: "x" }), "Diese Sitzung leeren: x");
    assert.equal(i18n.n(1234), "1.234");
    assert.match(i18n.ago(5), /Sekunden/);
  });
  withLang("en", () => {
    assert.equal(i18n.tn("rollupUnavailable", 3), "Results unavailable for 3 annotations");
    assert.equal(i18n.tn("rollupUnavailable", 1), "Results unavailable for 1 annotation");
    assert.match(i18n.ago(0), /now/);
  });
  withLang("sv", () => {
    assert.equal(i18n.tn("statusSending", 2), "Skickar 2 anteckningar…");
  });
});

test("the toolbar tooltip is translated through the same resolver", () => {
  const monitor = require(path.join(SRC, "monitor.js"));
  withLang("sv", () => {
    assert.equal(monitor.titleFor("done", i18n.t), bundled.sv.toolbarDone);
  });
  withLang("en", () => {
    assert.equal(monitor.titleFor("working", i18n.t), "Ulla-Bella: Hermes is working…");
    assert.equal(monitor.titleFor("", i18n.t), "Ulla-Bella");
  });
});
