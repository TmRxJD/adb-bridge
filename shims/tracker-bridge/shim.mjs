import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * Shared body of the tracker-bridge and cifi-bridge compatibility shims.
 *
 * Both packages were single-game bridges. adb-bridge serves the same games,
 * and more, from one install. Rather than leave people on an unmaintained
 * package -- or break every link and README that says `npx tracker-bridge` --
 * these keep working and hand over.
 *
 * The handover is deliberate about three things:
 *
 *  - It enables the shim's game once, so a user who never runs `games add`
 *    still gets exactly the bridge they had before.
 *  - It clears the old autostart entries, because leaving one means the old
 *    bridge and the new one both start at sign-in and race for the port.
 *  - It forwards argv unchanged, so any documented flag still does what it did.
 */
export async function runShim({ gameId, gameName, oldPackage }) {
  const require = createRequire(import.meta.url)

  // An "exports" map can block deep subpaths, so try the declared entry first
  // and fall back to walking up from the package's own main module.
  let adbBridgeBin = null
  try {
    adbBridgeBin = require.resolve('adb-bridge/bin/adb-bridge.js')
  } catch {
    try {
      const main = require.resolve('adb-bridge')
      const candidate = path.join(path.dirname(path.dirname(main)), 'bin', 'adb-bridge.js')
      if (existsSync(candidate)) adbBridgeBin = candidate
    } catch {
      // Reported below.
    }
  }

  if (!adbBridgeBin) {
    console.error(
      `${oldPackage} is now a thin wrapper around adb-bridge, which could not be found.\n` +
      'Install it with:  npm install -g adb-bridge\n' +
      'Or just run:      npx adb-bridge',
    )
    process.exitCode = 1
    return
  }

  const args = process.argv.slice(2)

  // Announce the change once, on the interactive path only -- a scripted or
  // background invocation should not have its output shape changed.
  if (process.stdout.isTTY && !args.includes('--skip-intro')) {
    console.log(`${oldPackage} is now part of adb-bridge, which serves ${gameName} and other games.`)
    console.log('Everything below is adb-bridge. Next time you can run: adb-bridge\n')
  }

  try {
    const { enableGame, isGameEnabled, removeLegacyBootEntries } = await import('adb-bridge')
    if (!isGameEnabled(gameId)) {
      enableGame(gameId)
      console.log(`Enabled ${gameName} on adb-bridge.`)
    }
    for (const entry of await removeLegacyBootEntries()) {
      console.log(`Removed the old ${entry}; adb-bridge handles startup now.`)
    }
  } catch (error) {
    // A failure here must not stop the bridge running -- worst case the user
    // has to enable the game themselves.
    console.warn(`Could not migrate settings automatically: ${error?.message || error}`)
  }

  const child = spawn(process.execPath, [adbBridgeBin, ...args], { stdio: 'inherit' })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 0
  })
}
