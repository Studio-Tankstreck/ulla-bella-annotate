#!/usr/bin/env bash
# Ulla-Bella Extension — deterministic release packaging (Task 14).
#
# Produces dist/ulla-bella-extension-<version>.zip from extension/ with:
#   - the canonical Relay origin injected into host_permissions + relay-policy
#   - dev-only files (tests, README, config.js, fixtures) excluded
#   - a secret/pattern scan that fails the build on any forbidden content
#
# Two mutually exclusive build modes:
#
#   RELAY_ORIGIN=https://relay.example.com ./scripts/package-extension.sh
#     Canonical build: that one Relay origin is baked into host_permissions and
#     into the pairing allowlist. Used for a hosted/known Relay.
#
#   RELAY_PORTABLE=1 ./scripts/package-extension.sh
#     Portable build: no Relay is baked in. host_permissions stays empty and the
#     allowlist stays empty; the user grants their own Relay origin at import
#     time and only a granted origin is accepted. This is the mode for public
#     distribution.
#
#   VERSION=0.1.0 ... adds an explicit version (defaults to the manifest's).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/extension"
DIST="$ROOT/dist"
STAGE="$DIST/.stage"
VERSION="${VERSION:-0.1.0}"
RELAY_ORIGIN="${RELAY_ORIGIN:-}"
RELAY_PORTABLE="${RELAY_PORTABLE:-}"

PORTABLE=0
if [ "$RELAY_PORTABLE" = "1" ]; then
  if [ -n "$RELAY_ORIGIN" ]; then
    echo "error: set either RELAY_ORIGIN or RELAY_PORTABLE=1, not both" >&2
    exit 1
  fi
  PORTABLE=1
else
  if [ -z "$RELAY_ORIGIN" ]; then
    echo "error: RELAY_ORIGIN is required (or RELAY_PORTABLE=1 for a portable build)" >&2
    exit 1
  fi
  # Normalize: strip any trailing slash / path.
  RELAY_ORIGIN="$(printf '%s' "$RELAY_ORIGIN" | sed 's#/$##')"
  case "$RELAY_ORIGIN" in
    http://*|https://*) ;;
    *) echo "error: RELAY_ORIGIN must be http(s)://host[:port]" >&2; exit 1 ;;
  esac
fi

ZIP="$DIST/ulla-bella-extension-$VERSION.zip"

rm -rf "$STAGE"
mkdir -p "$STAGE/src" "$STAGE/icons" "$DIST"

# 1. Stage ONLY the runtime files. Nothing else (test/, README, config.js,
#    fixtures, node_modules) reaches the package.
cp "$EXT/manifest.json" "$STAGE/manifest.json"
for f in lib.js queue.js session.js session-writer.js connections.js pair.js relay-policy.js icons.js monitor.js \
         i18n.js i18n-messages.js background.js content.js \
         popup.html popup.js popup.css annotate.css; do
  cp "$EXT/src/$f" "$STAGE/src/$f"
done
if [ -d "$EXT/icons" ]; then cp -r "$EXT/icons/." "$STAGE/icons/"; fi
# Translations: Chrome reads these for the manifest strings, and src/i18n.js
# reads the bundled copy for the extension's own UI.
if [ -d "$EXT/_locales" ]; then cp -r "$EXT/_locales/." "$STAGE/_locales/"; fi

# 2. Inject the Relay origin, verify, and build a deterministic ZIP (fixed
#    timestamps, sorted entries) — all in one Python pass.
python3 - "$STAGE" "$RELAY_ORIGIN" "$ZIP" "$VERSION" "$PORTABLE" <<'PY'
import json, pathlib, re, sys, zipfile

stage = pathlib.Path(sys.argv[1])
origin = sys.argv[2]
zip_path = pathlib.Path(sys.argv[3])
portable = sys.argv[5] == "1"

# --- inject ---------------------------------------------------------------
host_permissions = [] if portable else [origin + "/*"]
mp = stage / "manifest.json"
m = json.loads(mp.read_text())
m["host_permissions"] = host_permissions
mp.write_text(json.dumps(m, indent=2, ensure_ascii=False) + "\n")

rp = stage / "src" / "relay-policy.js"
text = rp.read_text()
if '["__RELAY_ORIGIN__"]' not in text:
    sys.exit("relay-policy.js missing __RELAY_ORIGIN__ placeholder")
if '"__UB_PORTABLE__"' not in text:
    sys.exit("relay-policy.js missing __UB_PORTABLE__ token")
allowed = [] if portable else [origin]
text = text.replace('["__RELAY_ORIGIN__"]', json.dumps(allowed))
text = text.replace('"__UB_PORTABLE__"', '"true"' if portable else '"false"')
rp.write_text(text)
for token in ("__RELAY_ORIGIN__", "__UB_PORTABLE__"):
    if token in text:
        sys.exit("relay-policy.js still carries the %s placeholder" % token)

# --- verify (Part 16) -----------------------------------------------------
def is_dev_origin(o):
    return re.match(r"^https?://(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)",
                    o, re.I) is not None

BAD_NAMES = (".env", ".key", ".pem", ".ullabella", "credentials", ".secret", ".pfx", ".p12")
fail = []

def scan(p, rel):
    text = p.read_text(errors="replace")
    if any(b in p.name.lower() for b in BAD_NAMES):
        fail.append(f"{rel}: forbidden filename")
    if re.search(r"-----BEGIN [A-Z ]*PRIVATE KEY-----", text):
        fail.append(f"{rel}: private key material")
    if re.search(r"ullabella-joomla|ddev\.site", text, re.I):
        fail.append(f"{rel}: leaked dev Site origin")
    if re.search(r"(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][A-Za-z0-9_\-]{12,}['\"]", text, re.I):
        fail.append(f"{rel}: hardcoded credential")

for p in sorted(stage.rglob("*")):
    if p.is_dir():
        continue
    scan(p, str(p.relative_to(stage)))

# A portable build has no known Relay origin, so nothing dev-ish may appear
# anywhere in the package; a canonical build keeps the same rule unless its own
# Relay origin is a dev origin.
if portable or not is_dev_origin(origin):
    for p in sorted(stage.rglob("*")):
        if p.is_dir():
            continue
        rel = str(p.relative_to(stage))
        text = p.read_text(errors="replace")
        for pat in (r"192\.168\.", r"localhost", r"127\.0\.0\.1", r"10\.\d+\.\d+\.\d+"):
            if re.search(pat, text, re.I):
                fail.append(f"{rel}: leaked dev origin {pat!r}")

# Manifest + required-file sanity.
m = json.loads((stage / "manifest.json").read_text())
if m.get("manifest_version") != 3:
    fail.append("manifest: manifest_version != 3")
if m.get("host_permissions") != host_permissions:
    fail.append(f"manifest: host_permissions != {host_permissions}")
if m.get("version") != sys.argv[4]:
    fail.append(f"manifest: version {m.get('version')} != {sys.argv[4]}")
for req in ("src/background.js", "src/content.js", "src/queue.js", "src/session.js", "src/session-writer.js", "src/connections.js", "src/lib.js", "src/pair.js",
            "src/relay-policy.js", "src/icons.js", "src/monitor.js", "src/i18n.js", "src/i18n-messages.js",
            "src/popup.html", "src/popup.js",
            "src/popup.css", "src/annotate.css"):
    if not (stage / req).exists():
        fail.append(f"missing required file: {req}")

# Translations must all ship: the manifest defaults to en and falls back to it,
# so a locale missing from the package is a silently untranslated UI.
LOCALES = ["en", "sv", "de", "es", "it", "nl", "nb", "da", "fi"]
msg_keys = set(re.findall(r"__MSG_([A-Za-z0-9_]+)__", (stage / "manifest.json").read_text()))
for lang in LOCALES:
    path = stage / "_locales" / lang / "messages.json"
    if not path.exists():
        fail.append(f"missing locale: _locales/{lang}/messages.json")
        continue
    table = json.loads(path.read_text())
    for key in sorted(msg_keys):
        if key not in table:
            fail.append(f"locale {lang}: manifest message {key} missing")
for icon in ("icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png"):
    if not (stage / icon).exists():
        fail.append(f"missing required icon: {icon}")

if fail:
    print("package verification FAILED:")
    for f in fail:
        print("  -", f)
    sys.exit(1)
print("package verification: OK")

# --- deterministic ZIP -----------------------------------------------------
zip_path.parent.mkdir(parents=True, exist_ok=True)
if zip_path.exists():
    zip_path.unlink()
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for p in sorted(stage.rglob("*")):
        if p.is_dir():
            continue
        arcname = p.relative_to(stage).as_posix()
        zi = zipfile.ZipInfo(arcname, (2026, 1, 1, 0, 0, 0))
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.external_attr = 0o644 << 16
        z.writestr(zi, p.read_bytes())

names = zipfile.ZipFile(zip_path).namelist()
assert "manifest.json" in names, "manifest.json not at ZIP root"
assert not [n for n in names if n.startswith("/") or n.startswith("..")], "unsafe zip paths"
print(f"built: {zip_path} ({len(names)} entries, manifest.json at root, "
      f"{'portable' if portable else 'canonical ' + origin})")
PY

rm -rf "$STAGE"
echo "done: $ZIP"
