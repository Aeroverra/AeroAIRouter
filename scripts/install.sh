#!/usr/bin/env bash
# Guided AeroAIRouter setup. Scaffolds AIROUTER_HOME (config + secrets + persona)
# without overwriting anything that already exists. Idempotent.
set -euo pipefail
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AIROUTER_HOME="${AIROUTER_HOME:-$HOME/.aeroairouter}"

echo "AeroAIRouter setup"
echo "  install dir : $INSTALL_DIR"
echo "  config home : $AIROUTER_HOME"

node -e 'process.exit(parseInt(process.versions.node,10) >= 20 ? 0 : 1)' \
  || { echo "ERROR: Node.js 20+ is required."; exit 1; }

echo "Installing dependencies..."
( cd "$INSTALL_DIR" && { npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev; } )

mkdir -p "$AIROUTER_HOME"/data "$AIROUTER_HOME"/persona "$AIROUTER_HOME"/credentials "$AIROUTER_HOME"/plugins
[ -f "$AIROUTER_HOME/config.json" ] || cp "$INSTALL_DIR/examples/config.example.json" "$AIROUTER_HOME/config.json"
if [ ! -f "$AIROUTER_HOME/secrets.env" ]; then
  cp "$INSTALL_DIR/examples/secrets.example.env" "$AIROUTER_HOME/secrets.env"
  chmod 600 "$AIROUTER_HOME/secrets.env"
fi
for f in soul heartbeat memory; do
  [ -f "$AIROUTER_HOME/persona/$f.md" ] || cp "$INSTALL_DIR/examples/persona/$f.example.md" "$AIROUTER_HOME/persona/$f.md"
done

cat <<NEXT

Setup scaffolded. Next steps:
  1) Edit $AIROUTER_HOME/secrets.env
       - DISCORD_TOKEN (required)
       - ANTHROPIC_API_KEY  OR  CLAUDE_CODE_OAUTH_TOKEN  (choose one; both supported)
  2) Edit $AIROUTER_HOME/config.json  (ownerId, guilds, channels, people)
  3) Optionally edit $AIROUTER_HOME/persona/*.md
  4) Start:
       AIROUTER_HOME="$AIROUTER_HOME" node "$INSTALL_DIR/src/index.js"
     Or install as a service: see scripts/aeroairouter.service.template
NEXT
