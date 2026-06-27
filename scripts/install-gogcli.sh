#!/usr/bin/env bash
# Install the gogcli (`gog`) binary used by the bundled `gog` plugin.
# Downloads the right prebuilt release for this OS/arch — no Go toolchain needed.
#
# Usage:
#   scripts/install-gogcli.sh [version]
# Env:
#   AIROUTER_HOME   install root (default ~/.aeroairouter); binary -> $AIROUTER_HOME/bin/gog
#   GOGCLI_VERSION  pin a version (e.g. 0.31.1); default = latest release
set -euo pipefail

REPO="openclaw/gogcli"
HOME_DIR="${AIROUTER_HOME:-$HOME/.aeroairouter}"
BIN_DIR="$HOME_DIR/bin"
VERSION="${1:-${GOGCLI_VERSION:-}}"

# OS
case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) echo "Unsupported OS: $(uname -s). Install gogcli manually: https://github.com/$REPO/releases" >&2; exit 1 ;;
esac
# Arch
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

# Resolve latest version if not pinned.
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -m1 '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/')"
fi
[ -n "$VERSION" ] || { echo "Could not determine gogcli version" >&2; exit 1; }

ASSET="gogcli_${VERSION}_${OS}_${ARCH}.tar.gz"
URL="https://github.com/$REPO/releases/download/v${VERSION}/${ASSET}"

echo "Installing gogcli v$VERSION ($OS/$ARCH) -> $BIN_DIR/gog"
mkdir -p "$BIN_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$ASSET" "$URL"
tar xzf "$TMP/$ASSET" -C "$TMP"
BIN="$(find "$TMP" -maxdepth 2 -type f -name gog | head -1)"
[ -n "$BIN" ] || { echo "gog binary not found in $ASSET" >&2; exit 1; }
install -m 0755 "$BIN" "$BIN_DIR/gog"
"$BIN_DIR/gog" version || true

cat <<EOF

Installed. Next:
  1) One-time auth (per Google account):
       $BIN_DIR/gog auth credentials /path/to/client_secret.json
       GOG_KEYRING_PASSWORD=<choose-one> $BIN_DIR/gog auth add you@gmail.com --services gmail,calendar,drive
  2) Put GOG_KEYRING_PASSWORD in the gog plugin (Plugins tab), enable it, restart the bot.
See plugins/gog/mcp/README.md for the headless (--remote) auth flow.
EOF
