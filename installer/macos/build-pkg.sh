#!/bin/bash
# =============================================================================
#  Build AdbBridge.pkg (macOS installer wizard).
#  Must run on macOS - uses pkgbuild/productbuild from the Xcode CLI tools.
#
#  Usage:  ./build-pkg.sh [version]
#  Output: dist/AdbBridge-<version>.pkg
#
#  Games are separate component packages so the installer can offer them as
#  checkboxes: a .pkg cannot hand a choice state to a single postinstall.
#
#  Signing (optional, removes the Gatekeeper warning):
#    export ADB_BRIDGE_SIGN_ID="Developer ID Installer: Your Name (TEAMID)"
# =============================================================================
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_root="$(cd "$here/../.." && pwd)"
version="${1:-$(node -p "require('$pkg_root/package.json').version")}"
build="$here/.build"
dist="$pkg_root/dist"

rm -rf "$build"
mkdir -p "$build/pkgs" "$dist"

# --- core: the launcher, the docs, and the npm install -----------------------
mkdir -p "$build/core-root/usr/local/share/adb-bridge" "$build/core-scripts"
install -m 0755 "$here/adb-bridge-launch.command" \
  "$build/core-root/usr/local/share/adb-bridge/adb-bridge-launch.command"
install -m 0644 "$pkg_root/LICENSE" "$build/core-root/usr/local/share/adb-bridge/LICENSE"
install -m 0644 "$pkg_root/README.md" "$build/core-root/usr/local/share/adb-bridge/README.md"
install -m 0755 "$here/scripts/core/postinstall" "$build/core-scripts/postinstall"

pkgbuild \
  --root "$build/core-root" \
  --scripts "$build/core-scripts" \
  --identifier "io.github.tmrxjd.adb-bridge.core" \
  --version "$version" \
  --install-location "/" \
  "$build/pkgs/core.pkg"

# --- one payload-free package per game --------------------------------------
for game in thetower cifi; do
  mkdir -p "$build/$game-scripts" "$build/$game-root"
  install -m 0755 "$here/scripts/$game/postinstall" "$build/$game-scripts/postinstall"
  # enable-game.sh sits beside the postinstall; both land in the scripts dir.
  install -m 0755 "$here/scripts/enable-game.sh" "$build/$game-scripts/enable-game.sh"

  pkgbuild \
    --root "$build/$game-root" \
    --scripts "$build/$game-scripts" \
    --identifier "io.github.tmrxjd.adb-bridge.$game" \
    --version "$version" \
    --install-location "/" \
    "$build/pkgs/$game.pkg"
done

# --- wrap them up with the choices UI ---------------------------------------
cp "$pkg_root/LICENSE" "$build/pkgs/LICENSE"
productbuild \
  --distribution "$here/distribution.xml" \
  --package-path "$build/pkgs" \
  --resources "$build/pkgs" \
  "$build/unsigned.pkg"

out="$dist/AdbBridge-$version.pkg"
if [ -n "${ADB_BRIDGE_SIGN_ID:-}" ]; then
  productsign --sign "$ADB_BRIDGE_SIGN_ID" "$build/unsigned.pkg" "$out"
  echo "Signed with: $ADB_BRIDGE_SIGN_ID"
else
  cp "$build/unsigned.pkg" "$out"
  echo "Unsigned: users will need to right-click -> Open once."
fi

rm -rf "$build"
echo "Built: $out"
