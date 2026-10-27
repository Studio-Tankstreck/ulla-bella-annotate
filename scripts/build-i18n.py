#!/usr/bin/env python3
"""Bundle extension/_locales/*/messages.json into extension/src/i18n-messages.js.

The _locales files are the authored source of every translation (they are also
what Chrome itself reads for the manifest strings). The extension's own UI needs
them synchronously in three contexts — popup, content script, service worker —
and chrome.i18n.getMessage cannot serve a MANUALLY chosen language, so this
script bundles the same data as one UMD module. There is no second copy of the
wording anywhere: change _locales and re-run this script.

Usage:
  scripts/build-i18n.py              # (re)write src/i18n-messages.js
  scripts/build-i18n.py --check      # exit 1 if the committed file is stale

The output is deterministic (locale order and key order are fixed), so --check is
a plain byte comparison and a diff only appears when a locale really changed.
"""
import json
import pathlib
import sys

# Locale order of the bundle. Chrome's own directory order is irrelevant; a fixed
# order keeps the generated file stable in diffs.
LOCALES = ["en", "sv", "de", "es", "it", "nl", "nb", "da", "fi"]

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOCALES_DIR = ROOT / "extension" / "_locales"
OUT = ROOT / "extension" / "src" / "i18n-messages.js"

HEADER = """// GENERATED FILE — do not edit by hand.
//
// Source of truth: extension/_locales/<lang>/messages.json (Chrome's i18n format,
// also read by Chrome for the manifest strings). Rebuild with:
//   scripts/build-i18n.py
// i18n.test.js fails if this file and the locale files ever disagree.
//
// Bundled so the extension's own UI can resolve a MANUALLY chosen language
// synchronously — chrome.i18n.getMessage only ever answers in the browser's UI
// language.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.UllaBellaMessages = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  return {
"""


def build():
    missing = [lang for lang in LOCALES if not (LOCALES_DIR / lang / "messages.json").is_file()]
    if missing:
        sys.exit("missing locale file(s): " + ", ".join(missing))

    out = [HEADER]
    for index, lang in enumerate(LOCALES):
        data = json.loads((LOCALES_DIR / lang / "messages.json").read_text(encoding="utf-8"))
        out.append("    %s: {\n" % json.dumps(lang))
        for key in sorted(data):
            message = data[key]["message"]
            out.append("      %s: %s,\n" % (json.dumps(key), json.dumps(message, ensure_ascii=False)))
        out.append("    }" + ("," if index < len(LOCALES) - 1 else "") + "\n")
    out.append("  };\n});\n")
    return "".join(out)


def main():
    text = build()
    check = "--check" in sys.argv[1:]
    if check:
        current = OUT.read_text(encoding="utf-8") if OUT.is_file() else ""
        if current != text:
            sys.exit("stale: %s — run scripts/build-i18n.py" % OUT.relative_to(ROOT))
        print("i18n bundle up to date (%d locales)" % len(LOCALES))
        return
    OUT.write_text(text, encoding="utf-8", newline="\n")
    print("wrote %s (%d locales)" % (OUT.relative_to(ROOT), len(LOCALES)))


if __name__ == "__main__":
    main()
