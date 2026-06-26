#!/usr/bin/env bash
# AeroAIRouter self-update: fast-forward to origin/<branch>, reinstall deps, restart.
# Prints ALREADY_UP_TO_DATE / UPDATED <old>..<new> / DIRTY_TREE for the caller.
set -euo pipefail
BRANCH="${1:-main}"
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR"

if [ ! -d .git ]; then echo "NOT_A_GIT_CHECKOUT"; exit 1; fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "DIRTY_TREE: refusing to auto-update (uncommitted changes present)"; exit 1
fi

git fetch --quiet origin "$BRANCH"
OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse "origin/$BRANCH")"
if [ "$OLD" = "$NEW" ]; then echo "ALREADY_UP_TO_DATE $OLD"; exit 0; fi

git merge --ff-only "origin/$BRANCH"
npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev
echo "UPDATED ${OLD:0:8}..${NEW:0:8}"

SERVICE="${SERVICE_NAME:-aeroairouter.service}"
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user restart "$SERVICE" 2>/dev/null \
    || systemctl --user restart azula-bot.service 2>/dev/null \
    || true
fi
