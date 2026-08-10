#!/bin/bash
# Double-clickable launcher installed alongside the package.
set -u

# Homebrew and the version managers are not on a Finder-launched PATH.
for p in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.fnm" "$HOME/.nvm/versions/node"/*/bin; do
  [ -d "$p" ] && export PATH="$p:$PATH"
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found."
  echo
  echo "Install it from https://nodejs.org (or 'brew install node'), then run"
  echo "this again."
  # Only wait for a keypress when someone is there to press one.
  [ -t 0 ] && read -r -p "Press return to close." _
  exit 1
fi

args=("$@")
if [ ${#args[@]} -eq 0 ]; then
  args=(--skip-intro --no-boot)
fi

if command -v adb-bridge >/dev/null 2>&1; then
  adb-bridge "${args[@]}"
else
  npx -y adb-bridge@latest "${args[@]}"
fi
status=$?

# Called with arguments means a script is driving us; do not block on input.
if [ ${#} -eq 0 ] && [ -t 0 ]; then
  echo
  read -r -p "ADB Bridge has stopped. Press return to close." _
fi
exit $status
