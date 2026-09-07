import assert from 'node:assert/strict'
import test from 'node:test'

import { isLegacyWindowsStartupEntry, buildBootLaunchCommand } from '../src/boot-persistence.mjs'

// THE BUG THIS COVERS, measured on a real machine.
//
// The legacy cleanup was an exact-filename list holding 'Tracker Bridge.cmd'. The per-game Inno
// Setup installer does not write a .cmd -- it writes a SHORTCUT, "Tracker Bridge.lnk", pointing at
// a hidden .vbs launcher. So the cleanup found nothing, the old per-game bridge kept starting at
// sign-in, and it held port 43781 against the game adb-bridge would otherwise have served. The
// user's symptom was "the tower starts with my PC but I have to coax CIFI into being detected".
test('the real legacy Startup entry is recognised', () => {
  // The one that actually exists on disk, and that the old exact-name list missed.
  assert.equal(isLegacyWindowsStartupEntry('Tracker Bridge.lnk'), true)
  assert.equal(isLegacyWindowsStartupEntry('CIFI Bridge.lnk'), true)
  // The names the old list did cover must keep working.
  assert.equal(isLegacyWindowsStartupEntry('Tracker Bridge.cmd'), true)
  assert.equal(isLegacyWindowsStartupEntry('CIFI Bridge.cmd'), true)
  // Other launcher shapes the same installers could plausibly emit.
  assert.equal(isLegacyWindowsStartupEntry('tracker-bridge-hidden.vbs'), true)
  assert.equal(isLegacyWindowsStartupEntry('cifi_bridge.bat'), true)
})

// NEGATIVE CONTROL. A cleanup that deletes our own autostart would uninstall the bridge every time
// it was installed, so this is the assertion that matters most.
test('our own entry and unrelated startup items are never removed', () => {
  assert.equal(isLegacyWindowsStartupEntry('ADB Bridge.cmd'), false)
  assert.equal(isLegacyWindowsStartupEntry('OneDrive.lnk'), false)
  assert.equal(isLegacyWindowsStartupEntry('Steam.lnk'), false)
  assert.equal(isLegacyWindowsStartupEntry('desktop.ini'), false)
  assert.equal(isLegacyWindowsStartupEntry(''), false)
  assert.equal(isLegacyWindowsStartupEntry(undefined), false)
  // A document that merely mentions a bridge is not a launcher.
  assert.equal(isLegacyWindowsStartupEntry('Tracker Bridge notes.txt'), false)
})

test('the boot command starts the bridge without re-registering autostart', () => {
  const command = buildBootLaunchCommand()
  assert.match(command, /adb-bridge/)
  assert.match(command, /--daemon/)
  // --no-boot matters: the boot entry must not rewrite itself every sign-in.
  assert.match(command, /--no-boot/)
})

// MEASURED: the hidden boot process sat inside npx-cli.js with NOTHING listening, because npx does
// not see a globally installed adb-bridge and re-fetches it from the registry. A boot entry that
// can block on a download -- or on an "Ok to proceed?" prompt it has no console to answer -- is a
// bridge that silently does not start.
test('the npx fallback can never stop on a prompt', () => {
  assert.match(buildBootLaunchCommand(), /--yes/)
})
