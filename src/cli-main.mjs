import { createRequire } from 'node:module'
import { runGamesCommand } from './games/commands.mjs'
import { runOriginsCommand } from './origins-commands.mjs'
import { loadAllGameProfiles } from './games/registry.mjs'
import { canPrompt, pickGames } from './games/picker.mjs'
import { identifyPortOwner } from './port-owner.mjs'
import { compareVersions, maybeUpdateBridge } from './update-check.mjs'
import { setAutoUpdateEnabled } from './bridge-config.mjs'
import { bridgeIsConfigured, enableGame, readEnabledGameIds } from './bridge-state.mjs'
import {
  installBootEntry,
  upgradeVisibleBootEntry,
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
  adb-bridge                        Serve every enabled game (asks which on first run)
  adb-bridge setup                  Choose which games to serve, then serve
  adb-bridge <game>                 Enable that game if needed, then serve
  adb-bridge games list             Show available and enabled games
  adb-bridge games add [id]         Enable a game (no id: choose from a list)
  adb-bridge games remove <id>      Disable a game

Which sites may connect
  adb-bridge origins list [id]      Show the sites allowed to reach a game
  adb-bridge origins add <id> <origin>     Allow another site
  adb-bridge origins remove <id> <origin>  Withdraw one you added

Startup
  --boot                            Register autostart, then serve
  --boot-only                       Register autostart and exit (for installers)
  --remove-boot                     Remove autostart

Updates (on by default: checked at start and every 6 hours)
  --auto-update / --no-auto-update  Turn automatic updates on or off
  --no-update                       Skip the check for this run only

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
    noUpdate: flags.has('--no-update'),
    autoUpdateOn: flags.has('--auto-update'),
    autoUpdateOff: flags.has('--no-auto-update'),
  }
}

/** How often a running bridge looks for a newer release. */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * A current adb-bridge already serving one of the enabled games means this run
 * has nothing to do: that bridge follows the enabled-games list by itself.
 * Starting a second one would only fight it for the ports.
 *
 * An older one is not reused -- it may predate following the list, or the
 * fixes this release carries -- so startBridge replaces it instead.
 */
async function findCurrentRunningBridge(enabledIds) {
  const { profiles } = loadAllGameProfiles()
  for (const id of enabledIds) {
    const profile = profiles.get(id)
    if (!profile) continue
    const owner = await identifyPortOwner(profile.port)
    if (owner.kind === 'bridge' && owner.version && compareVersions(owner.version, version) >= 0) {
      return owner
    }
  }
  return null
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

  // The help text and the updater have long told people to use these two
  // flags, and nothing parsed them.
  if (options.autoUpdateOn || options.autoUpdateOff) {
    setAutoUpdateEnabled(options.autoUpdateOn)
    log(`Automatic updates are ${options.autoUpdateOn ? 'on' : 'off'}.`)
    return 0
  }

  // Update before anything else, so the setup prompt and serving all come from
  // the newest release. The updater existed but nothing called it, so every
  // install stayed on whatever version it first ran. Installers and boot
  // registration are excluded: they must return promptly, and the bridge they
  // start will update itself.
  if (!options.bootOnly && !options.removeBoot) {
    const update = await maybeUpdateBridge({ currentVersion: version, argv, log, noUpdate: options.noUpdate })
    if (update.handedOff) return update.status ?? 0
  }

  // `adb-bridge thetower` -- enable that game if it is not already, then serve.
  //
  // A game's own website tells people to run one command. Without this that is
  // two (`games add`, then the bare command), and someone who runs only the
  // second gets "No games are enabled", which reads as the bridge being broken
  // rather than as a missing setup step.
  const requested = options.positional[0]
  if (requested === 'setup') {
    if (!canPrompt()) {
      log('`adb-bridge setup` needs an interactive terminal. Use `adb-bridge games add <id>` instead.')
      return 1
    }
    await pickGames({ log })
  } else if (requested) {
    const { profiles } = loadAllGameProfiles()
    const profile = profiles.get(requested.toLowerCase())
    if (!profile) {
      log(`No game or command called "${requested}".`)
      log('Run `adb-bridge games list` to see what is available, or --help for commands.')
      return 1
    }
    if (!readEnabledGameIds().includes(profile.id)) {
      enableGame(profile.id)
      log(`Enabled ${profile.name} (port ${profile.port}).`)
    }
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
  } else {
    try {
      await upgradeVisibleBootEntry(log)
    } catch {
      // Autostart cosmetics must never stop the bridge from serving.
    }
  }
  if (!options.boot) {
    // Someone upgrading from tracker-bridge or cifi-bridge would otherwise keep
    // starting the old bridge at sign-in alongside this one. This used to be
    // skipped under --no-boot -- which the Windows launcher always passes, so
    // exactly those users kept an old cifi-bridge squatting on CIFI's port.
    // --no-boot means "don't register autostart", not "keep the old one".
    for (const entry of await removeLegacyBootEntries()) {
      log(`Removed the old per-game ${entry}; adb-bridge starts them all now.`)
    }
  }

  if (readEnabledGameIds().length === 0) {
    // Nobody to ask at sign-in or under an installer; fail with the list there.
    if (options.daemon || !canPrompt()) {
      reportNothingEnabled(log)
      return 1
    }
    await pickGames({ log })
  }

  const running = await findCurrentRunningBridge(readEnabledGameIds())
  if (running) {
    log(`ADB Bridge ${running.version} is already running in the background (process ${running.pid}).`)
    log("Nothing else to do -- refresh the game's website. Newly enabled games are picked up automatically.")
    return 0
  }

  const { startBridge } = await import('./bridge.mjs')
  const bridgeOptions = { log, installPlugins: true, prepareAdb: true, takeOverPorts: true, watchConfig: true }
  let bridge = await startBridge(bridgeOptions)

  // A bridge that starts at sign-in and runs for weeks would otherwise only
  // ever update on a reboot. Close the ports first so the new copy can bind
  // them; if it fails to launch, serve again rather than go dark.
  if (!options.noUpdate) {
    setInterval(async () => {
      let closed = false
      const update = await maybeUpdateBridge({
        currentVersion: version,
        argv,
        log,
        periodic: true,
        beforeHandOff: async () => {
          closed = true
          await bridge.close()
        },
      })
      if (update.handedOff) process.exit(update.status ?? 0)
      if (closed) bridge = await startBridge(bridgeOptions)
    }, UPDATE_CHECK_INTERVAL_MS)
  }

  if (!options.daemon) {
    log("\nReady. Leave this window open, then refresh the game's website.")
  }
  if (!options.daemon && !options.skipIntro) {
    if (!(await isBootEntryInstalled())) {
      log('Tip: `adb-bridge --boot` starts it automatically when you sign in.')
    }
  }
  return 0
}

export { bridgeIsConfigured, enableGame }
