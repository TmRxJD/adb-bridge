#!/bin/bash
# Launcher installed to /usr/bin, used by the desktop entry and by hand.
set -u

# Version managers are not on a desktop-launched PATH.
for p in "$HOME/.volta/bin" "$HOME/.fnm" /usr/local/bin "$HOME/.nvm/versions/node"/*/bin; do
  [ -d "$p" ] && export PATH="$p:$PATH"
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it with your package manager, then run:"
  echo "  npx adb-bridge"
  exit 1
fi

args=("$@")
if [ ${#args[@]} -eq 0 ]; then
  args=(--skip-intro --no-boot)
fi

if command -v adb-bridge >/dev/null 2>&1; then
  exec adb-bridge "${args[@]}"
fi
exec npx -y adb-bridge@latest "${args[@]}"
