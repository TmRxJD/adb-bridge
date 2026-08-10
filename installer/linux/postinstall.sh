#!/bin/bash
# Runs after the .deb/.rpm lays its files down.
#
# Best effort throughout: the launcher falls back to npx, so a failed global
# install is a slower first run rather than a broken package, and exiting
# non-zero here would fail the whole installation.
set -u

log() { echo "[adb-bridge] $*"; }

# sudo's secure_path strips most of PATH, so a Node installed anywhere other
# than /usr/bin is invisible to this script even though the user has it. Look
# in the usual places before giving up -- the Windows installer had the same
# blind spot and declared Node missing on machines that had it.
for p in /usr/local/bin /opt/homebrew/bin "$HOME/.volta/bin" /usr/local/n/versions/node/*/bin; do
  [ -d "$p" ] && export PATH="$p:$PATH"
done

if command -v npm >/dev/null 2>&1; then
  npm install -g adb-bridge@latest --no-audit --no-fund --loglevel=error \
    || log "global install failed; the launcher will use npx"
else
  log "npm not reachable from the package script; will try as the installing user"
fi

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

# Run through the user's own login shell rather than this script's stripped
# environment: they may manage Node with nvm/volta/fnm, whose shims only exist
# once their profile has been sourced. Falling back to npx covers the case
# where the root-level global install above could not run at all.
enable_as_user() {
  sudo -u "$TARGET_USER" HOME="$TARGET_HOME" bash -lc \
    'command -v adb-bridge >/dev/null 2>&1 \
       && exec adb-bridge games add thetower \
       || exec npx -y adb-bridge@latest games add thetower' >/dev/null 2>&1
}

if enable_as_user; then
  log "Enabled The Tower. Add more with: adb-bridge games add cifi"
  log "See all games with: adb-bridge games list"
else
  log "Could not enable a game automatically."
  log "Run: adb-bridge games add thetower"
fi

exit 0
