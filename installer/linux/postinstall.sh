#!/bin/bash
# Runs after the .deb/.rpm lays its files down.
#
# Best effort throughout: the launcher falls back to npx, so a failed global
# install is a slower first run rather than a broken package, and exiting
# non-zero here would fail the whole installation.
set -u

if command -v npm >/dev/null 2>&1; then
  npm install -g adb-bridge@latest --no-audit --no-fund --loglevel=error \
    || echo "[adb-bridge] global install failed; the launcher will use npx"
else
  echo "[adb-bridge] npm not found; the launcher will use npx"
  exit 0
fi

# Enable a game so the bridge has something to serve. Linux packaging has no
# checkbox UI, so pick the default and tell the user how to change it rather
# than enabling every game and binding ports they did not ask for.
TARGET_USER="${SUDO_USER:-${PKEXEC_UID:+$(id -nu "$PKEXEC_UID")}}"
if [ -n "${TARGET_USER:-}" ] && [ "$TARGET_USER" != "root" ]; then
  sudo -u "$TARGET_USER" adb-bridge games add thetower >/dev/null 2>&1 \
    || echo "[adb-bridge] run 'adb-bridge games add <game>' to choose a game"
fi

echo "[adb-bridge] Enabled The Tower. Add more with: adb-bridge games add cifi"
echo "[adb-bridge] See all games with: adb-bridge games list"
exit 0
