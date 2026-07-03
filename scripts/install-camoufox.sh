#!/usr/bin/env bash
# Install Camoufox (anti-detect Firefox) for the bundled `camoufox` plugin, into a
# self-contained Python venv under AIROUTER_HOME. Downloads a ~500MB patched
# Firefox via `camoufox fetch`. Best-effort installs the Linux system libs Firefox
# needs (requires passwordless sudo; otherwise it prints the manual command). Does
# not touch the system Python.
#
# Env:
#   AIROUTER_HOME   install root (default ~/.aeroairouter); venv -> $AIROUTER_HOME/camoufox-venv
set -uo pipefail

HOME_DIR="${AIROUTER_HOME:-$HOME/.aeroairouter}"
VENV="$HOME_DIR/camoufox-venv"
DEPS="libgtk-3-0 libx11-xcb1 libasound2 libdbus-glib-1-2 xvfb"

echo "Installing Camoufox into $VENV"

# 1) System libraries Firefox needs (best-effort).
if command -v apt-get >/dev/null 2>&1; then
  if sudo -n true 2>/dev/null; then
    sudo -n apt-get update -y >/dev/null 2>&1 || true
    if sudo -n apt-get install -y $DEPS >/dev/null 2>&1; then
      echo "SYSTEM_DEPS: ok"
    else
      echo "SYSTEM_DEPS: missing (apt install failed) — run manually: sudo apt-get install -y $DEPS"
    fi
  else
    echo "SYSTEM_DEPS: missing (no passwordless sudo) — run manually: sudo apt-get install -y $DEPS"
  fi
else
  echo "SYSTEM_DEPS: unknown (no apt) — ensure these libs are present: $DEPS"
fi

# 2) Python venv + camoufox package.
python3 -m venv "$VENV" || { echo "venv creation failed" >&2; exit 1; }
"$VENV/bin/pip" install --quiet --upgrade pip >/dev/null 2>&1 || true
echo "Installing camoufox (pip)…"
"$VENV/bin/pip" install --quiet -U "camoufox[geoip]" || { echo "pip install camoufox failed" >&2; exit 1; }

# 3) Download the patched Firefox binary (~500MB).
echo "Fetching the Camoufox browser binary (~500MB, this can take a few minutes)…"
"$VENV/bin/python" -m camoufox fetch || { echo "camoufox fetch failed" >&2; exit 1; }

VER="$("$VENV/bin/python" -c "import importlib.metadata as m;print(m.version('camoufox'))" 2>/dev/null)"
echo "STATUS: ok version=${VER:-unknown}"
