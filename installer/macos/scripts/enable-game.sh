#!/bin/bash
# Shared by the per-game component packages: enables one game on the bridge.
#
# Called as:  enable-game.sh <game-id>
#
# Runs as root during install, but the bridge's config belongs to the user who
# is installing -- writing it as root would leave a ~/.adb-bridge they cannot
# modify. $USER is the console user here, so drop to them explicitly.
set -u

GAME="${1:?usage: enable-game.sh <game-id>}"
log() { echo "[adb-bridge] $*"; }

for p in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do
  [ -d "$p" ] && export PATH="$p:$PATH"
done

# The user running Installer.app, not root.
TARGET_USER="${USER:-$(stat -f '%Su' /dev/console)}"
TARGET_HOME="$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
[ -z "$TARGET_HOME" ] && TARGET_HOME="/Users/$TARGET_USER"

run_as_user() {
  if [ "$(id -u)" = "0" ] && [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ]; then
    sudo -u "$TARGET_USER" HOME="$TARGET_HOME" "$@"
  else
    "$@"
  fi
}

if command -v adb-bridge >/dev/null 2>&1; then
  run_as_user adb-bridge games add "$GAME" || log "Could not enable $GAME"
elif command -v npx >/dev/null 2>&1; then
  run_as_user npx -y adb-bridge@latest games add "$GAME" || log "Could not enable $GAME"
else
  log "Neither adb-bridge nor npx is available; run 'adb-bridge games add $GAME' yourself."
fi

exit 0
