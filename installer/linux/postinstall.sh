#!/bin/bash
# Runs after the .deb/.rpm lays its files down.
#
# Best effort throughout: the launcher falls back to npx, so a failed global
# install is a slower first run rather than a broken package, and exiting
# non-zero here would fail the whole installation.
set -u

log() { echo "[adb-bridge] $*"; }

if ! command -v npm >/dev/null 2>&1; then
  log "npm not found; the launcher will use npx"
  exit 0
fi

npm install -g adb-bridge@latest --no-audit --no-fund --loglevel=error \
  || log "global install failed; the launcher will use npx"

# Enable a game so the bridge has something to serve. Linux packaging has no
# checkbox UI, so pick the default and say how to change it, rather than
# enabling every game and binding ports nobody asked for.
#
# The config belongs to the user installing, not to root: writing it as root
# leaves a ~/.adb-bridge they cannot edit, and the bridge then reads a
# different file than the one the installer wrote.
TARGET_USER="${SUDO_USER:-}"
if [ -z "$TARGET_USER" ] && [ -n "${PKEXEC_UID:-}" ]; then
  TARGET_USER="$(id -nu "$PKEXEC_UID" 2>/dev/null || true)"
fi

if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
  log "Installed for root; run 'adb-bridge games add <game>' as your own user."
  exit 0
fi

TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
[ -z "$TARGET_HOME" ] && TARGET_HOME="/home/$TARGET_USER"

# Resolve the binary here: sudo resets PATH, so a bare `adb-bridge` inside the
# sudo call is not guaranteed to resolve even though it just installed.
BRIDGE="$(command -v adb-bridge || true)"
if [ -z "$BRIDGE" ]; then
  log "adb-bridge is not on PATH yet; run 'adb-bridge games add thetower' to start."
  exit 0
fi

if sudo -u "$TARGET_USER" HOME="$TARGET_HOME" "$BRIDGE" games add thetower >/dev/null 2>&1; then
  log "Enabled The Tower. Add more with: adb-bridge games add cifi"
  log "See all games with: adb-bridge games list"
else
  log "Could not enable a game automatically."
  log "Run: adb-bridge games add thetower"
fi

exit 0
