#!/bin/bash
# =============================================================================
#  Build Linux packages for ADB Bridge.
#
#  Linux has no SmartScreen/Gatekeeper equivalent - a .deb/.rpm installed by the
#  distro's own package manager raises no security warning at all.
#
#  Usage:  ./build-packages.sh [version]
#  Output: dist/adb-bridge_<version>_all.deb
#          dist/adb-bridge-<version>.noarch.rpm   (when rpmbuild is available)
#
#  Requires: fpm (gem install fpm).
# =============================================================================
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_root="$(cd "$here/../.." && pwd)"
version="${1:-$(node -p "require('$pkg_root/package.json').version")}"
build="$here/.build"
dist="$pkg_root/dist"

rm -rf "$build"
mkdir -p "$build/usr/bin" "$build/usr/share/adb-bridge" "$build/usr/share/applications" "$dist"

install -m 0755 "$here/adb-bridge-launch.sh" "$build/usr/bin/adb-bridge-launch"
install -m 0644 "$pkg_root/LICENSE" "$build/usr/share/adb-bridge/LICENSE"
install -m 0644 "$pkg_root/README.md" "$build/usr/share/adb-bridge/README.md"

cat > "$build/usr/share/applications/adb-bridge.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=ADB Bridge
Comment=Local save bridge for Android games
Exec=adb-bridge-launch
Terminal=true
Categories=Utility;
DESKTOP

if ! command -v fpm >/dev/null 2>&1; then
  echo "fpm not found. Install it with:  gem install fpm"
  exit 1
fi

common=(
  -s dir -C "$build"
  --name adb-bridge
  --version "$version"
  --architecture all
  --maintainer "TmRxJD"
  --license "GPL-3.0-or-later"
  --url "https://github.com/TmRxJD/adb-bridge"
  --description "Pulls a game's save file off an Android device or emulator and serves it to a local website. One bridge, many games."
  --after-install "$here/postinstall.sh"
  --force
)

fpm "${common[@]}" -t deb -p "$dist/adb-bridge_${version}_all.deb" .
echo "Built: $dist/adb-bridge_${version}_all.deb"

if command -v rpmbuild >/dev/null 2>&1; then
  fpm "${common[@]}" -t rpm -p "$dist/adb-bridge-${version}.noarch.rpm" .
  echo "Built: $dist/adb-bridge-${version}.noarch.rpm"
else
  echo "rpmbuild not found; skipped the .rpm."
fi

rm -rf "$build"
