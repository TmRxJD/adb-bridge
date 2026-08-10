import { createRequire } from 'node:module'
import { runGamesCommand } from './games/commands.mjs'
import { runOriginsCommand } from './origins-commands.mjs'
import { loadAllGameProfiles } from './games/registry.mjs'
import { bridgeIsConfigured, enableGame, readEnabledGameIds } from './bridge-state.mjs'
import {
  installBootEntry,
  isBootEntryInstalled,
  removeBootEntry,
  removeLegacyBootEntries,
} from './boot-persistence.mjs'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

const HELP = `adb-bridge ${version}

Pulls a game's save off your Android device or emulator and serves it to a
local website. One bridge, many games.

Usage
  adb-bridge                        Serve every enabled game
  adb-bridge games list             Show available and enabled games
  adb-bridge games add <id>         Enable a game (joins an existing bridge)
  adb-bridge games remove <id>      Disable a game

Which sites may connect
  adb-bridge origins list [id]      Show the sites allowed to reach a game
  adb-bridge origins add <id> <origin>     Allow another site
  adb-bridge origins remove <id> <origin>  Withdraw one you added

Startup
  --boot                            Register autostart, then serve
  --boot-only                       Register autostart and exit (for installers)
  --remove-boot                     Remove autostart

Other
  --version                         Print the version
  --help                            This text

Add your own game by dropping a JSON profile in ~/.adb-bridge/games/.
Licensed GPL-3.0-or-later: https://github.com/TmRxJD/adb-bridge
`

function parseArgs(argv) {
  const flags = new Set(argv.filter(arg => arg.startsWith('--')))
  const positional = argv.filter(arg => !arg.startsWith('--'))
  return {
    positional,
    help: flags.has('--help') || flags.has('-h'),
    version: flags.has('--version'),
    boot: flags.has('--boot'),
    bootOnly: flags.has('--boot-only'),
    removeBoot: flags.has('--remove-boot'),
    noBoot: flags.has('--no-boot'),
    daemon: flags.has('--daemon'),
    skipIntro: flags.has('--skip-intro'),
  }
}

/**
 * First run with nothing enabled is the common case for someone who typed
 * `npx adb-bridge` after reading a game's site. Enabling nothing and exiting
 * would look broken, so offer the games list instead of failing silently.
 */
function reportNothingEnabled(log) {
  const { profiles } = loadAllGameProfiles()
  log('No games are enabled yet.\n')
  log('Available:')
  for (const profile of profiles.values()) {
    log(`  ${profile.id.padEnd(12)} ${profile.name}`)
  }
  log('\nEnable one with:  adb-bridge games add <id>')
}

export async function runCliMain(argv = process.argv.slice(2), log = console.log) {
  const options = parseArgs(argv)

  if (options.help) {
    log(HELP)
    return 0
  }

  if (options.version) {
    log(version)
    return 0
  }

  if (options.positional[0] === 'games') {
    return runGamesCommand(options.positional.slice(1), log)
  }

  if (options.positional[0] === 'origins') {
    return runOriginsCommand(options.positional.slice(1), log)
  }

  if (options.removeBoot) {
    await removeBootEntry(log)
    return 0
  }

  // Register the autostart entry and exit. `--boot` registers and then goes on
  // to serve, which is what a user running it wants but hangs an installer
  // waiting for the process to finish.
  if (options.bootOnly) {
    await installBootEntry(log)
    return 0
  }

  if (options.boot) {
    await installBootEntry(log)
  } else if (!options.noBoot) {
    // Someone upgrading from tracker-bridge or cifi-bridge would otherwise keep
    // starting the old bridge at sign-in alongside this one.
    for (const entry of await removeLegacyBootEntries()) {
      log(`Removed the old per-game ${entry}; adb-bridge starts them all now.`)
    }
  }

  if (readEnabledGameIds().length === 0) {
    reportNothingEnabled(log)
    return 1
  }

  const { startBridge } = await import('./bridge.mjs')
  await startBridge({ log })

  if (!options.daemon && !options.skipIntro) {
    log('\nLeave this terminal open while using the site.')
    if (!(await isBootEntryInstalled())) {
      log('Tip: `adb-bridge --boot` starts it automatically when you sign in.')
    }
  }
  return 0
}

export { bridgeIsConfigured, enableGame }
