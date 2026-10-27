#!/usr/bin/env bash
# Ulla-Bella Adapter — reproducible installer (Task 13, private beta).
# Linux/systemd only. Installs the Adapter as a persistent systemd service.
#
#   sudo scripts/install-adapter.sh
#   sudo scripts/install-adapter.sh --binary /path/to/ulla-bella-adapter
#
# It never overwrites an existing /etc/ulla-bella/adapter.yaml or adapter.env,
# and it never puts credentials in command history or on disk.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

CONFIG_DIR=/etc/ulla-bella
BIN_PATH=/usr/local/bin/ulla-bella-adapter
UNIT_SRC=deploy/ulla-bella-adapter.service
UNIT_DST=/etc/systemd/system/ulla-bella-adapter.service
CONFIG_DST="$CONFIG_DIR/adapter.yaml"
ENV_DST="$CONFIG_DIR/adapter.env"
SERVICE_USER=ullabella

BINARY_SRC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary) BINARY_SRC="${2:?--binary requires a path}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" != "0" ]]; then
  echo "error: run as root (e.g. sudo $0)" >&2
  exit 1
fi

# 1. Install the binary (build from source, or copy a prebuilt one).
if [[ -n "$BINARY_SRC" ]]; then
  install -m 0755 "$BINARY_SRC" "$BIN_PATH"
  echo "installed binary from $BINARY_SRC -> $BIN_PATH"
else
  if ! command -v go >/dev/null 2>&1; then
    echo "error: Go not found; install Go or pass --binary <path>" >&2
    exit 1
  fi
  VERSION="dev"
  COMMIT="unknown"
  BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
    if VERSION_TAG="$(git -C "$REPO_ROOT" describe --tags --always 2>/dev/null)"; then
      VERSION="$VERSION_TAG"
    fi
  fi
  tmpbin="$(mktemp)"
  trap 'rm -f "$tmpbin"' EXIT
  (cd "$REPO_ROOT" && go build -trimpath \
    -ldflags "-X main.version=$VERSION -X main.commit=$COMMIT -X main.buildDate=$BUILD_DATE" \
    -o "$tmpbin" ./hermes-adapter)
  install -m 0755 "$tmpbin" "$BIN_PATH"
  echo "built + installed $BIN_PATH (version=$VERSION commit=$COMMIT)"
fi

# 2. Config dir + dedicated non-root service user.
install -d -m 0755 "$CONFIG_DIR"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  echo "created system user $SERVICE_USER"
fi

# 3. Example config if absent (never overwrite an existing one).
if [[ -e "$CONFIG_DST" ]]; then
  echo "config exists (left untouched): $CONFIG_DST"
else
  install -m 0644 deploy/adapter.example.yaml "$CONFIG_DST"
  echo "installed example config: $CONFIG_DST"
fi

# 4. Protected env file if absent (never overwrite). Placeholders only.
if [[ -e "$ENV_DST" ]]; then
  echo "env file exists (left untouched): $ENV_DST"
else
  install -m 0600 -o root -g root deploy/ulla-bella-adapter.env.example "$ENV_DST"
  echo "installed empty env file (0600 root:root): $ENV_DST"
fi

# 5. systemd unit.
install -m 0644 "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
echo "installed systemd unit: $UNIT_DST"

echo
echo "Remaining configuration steps:"
echo "  1. Edit $CONFIG_DST  (relay url, agent id, hermes, sites)"
echo "  2. Put secret VALUES in $ENV_DST  (0600) — referenced by NAME in the config"
echo "  3. sudo systemctl enable --now ulla-bella-adapter"
echo "  4. sudo systemctl status ulla-bella-adapter"
echo "  5. ulla-bella-adapter validate --env-file $ENV_DST"
