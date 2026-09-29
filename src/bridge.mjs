import { loadAllGameProfiles, findPortConflicts } from './games/registry.mjs'
import { readEnabledGameIds } from './bridge-state.mjs'
import { startGameBridge } from './game-bridge.mjs'
import { loadUploaderForProfile } from './upload/uploader-plugin.mjs'
import { requireAdbExecutable } from './adb/adb-resolve.mjs'
import { identifyPortOwner, portIsFree, stopBridgeOnPort } from './port-owner.mjs'

/**
 * Starts one process serving every enabled game, each on its own port.
 *
 * The alternative -- a process per game -- is what this package exists to
 * replace: two bridges meant two autostart entries, two update checks, two adb
 * servers fighting over the same device, and two installers to keep in step.
 *
 * Ports stay per-game rather than multiplexing onto one, because each game's
 * website is already deployed against a fixed port. Adding a game must never
 * require redeploying a different game's site.
 */

/** How often the enabled-games list is re-read. Cheap: one small JSON file. */
const CONFIG_POLL_MS = 3_000

export async function startBridge(options = {}) {
  const log = options.log ?? console.log
  const { profiles, errors } = loadAllGameProfiles()

  // A broken user-written profile is worth saying out loud -- it was added on
  // purpose, and silence would look like the file was ignored.
  for (const problem of errors) {
    log(`Ignoring game profile: ${problem.message}`)
  }

  /** @type {Map<string, ReturnType<typeof startGameBridge>>} */
  const running = new Map()
  // Games that could not start are not retried every poll -- that would print
  // the same failure every few seconds. They are retried when the list changes.
  const failed = new Set()

  function resolveProfiles(ids) {
    const out = []
    for (const id of ids) {
      const profile = profiles.get(id)
      if (!profile) {
        log(`No game profile named "${id}"; run \`adb-bridge games list\` to see what is available.`)
        continue
      }
      out.push(profile)
    }
    return out
  }

  /**
   * A busy port used to end the game's startup. When the holder is an older
   * bridge (a per-game cifi-bridge/tracker-bridge, or an older adb-bridge),
   * stopping it IS the fix, so do that instead of telling the user to.
   */
  async function freePort(profile) {
    const port = options.port ?? profile.port
    const owner = await identifyPortOwner(port)
    if (owner.kind === 'bridge') {
      return stopBridgeOnPort(owner, port, log)
    }
    if (owner.kind === 'other') {
      log(
        `[${profile.id}] Port ${port} is used by another program`
        + `${owner.pid ? ` (process ${owner.pid}${owner.commandLine ? `: ${owner.commandLine}` : ''})` : ''}. `
        + `Close it, then the bridge starts ${profile.name} on its own.`,
      )
      return false
    }
    return true
  }

  async function startOne(profile) {
    if (options.takeOverPorts === true) await freePort(profile)
    // Only the CLI installs a missing plugin; embedders and tests never reach the network.
    const { uploader } = await loadUploaderForProfile(profile, log, { install: options.installPlugins === true })
    const bridge = startGameBridge(profile, { ...options, uploader })
    if (await bridge.ready) {
      running.set(profile.id, bridge)
      failed.delete(profile.id)
      return bridge
    }
    failed.add(profile.id)
    return null
  }

  const initial = resolveProfiles(options.gameIds ?? readEnabledGameIds())

  // Two games on one port would mean whichever bound first silently answers for
  // both -- serving one game's save to the other's website.
  const conflicts = findPortConflicts(initial)
  if (conflicts.length > 0) {
    throw new Error(`Cannot start: ${conflicts.join('; ')}.`)
  }

  if (initial.length === 0) {
    log('No games are enabled. Run `adb-bridge games add <id>` to enable one.')
  }

  // Wait for each to bind (or fail) before reporting, so the summary reflects
  // what is actually serving rather than what was attempted.
  const started = await Promise.all(initial.map(startOne))
  const serving = started.filter(Boolean)
  const notStarted = initial.filter((_, index) => !started[index])

  if (serving.length > 0) {
    log(
      `adb-bridge serving ${serving.length} game(s): `
      + serving.map(b => `${b.profile.name} (${b.port})`).join(', '),
    )
  }
  if (notStarted.length > 0) {
    log(`Could not start: ${notStarted.map(p => p.name).join(', ')}.`)
    // Something the user enabled is not working; say so in the exit code.
    process.exitCode = 1
  }

  // Get adb in place now, while the user is still switching to the site, rather
  // than on their first Pull: a first-run download inside that request can
  // outlast the site's pull timeout. Not awaited -- serving must not wait on it,
  // and a failure here is retried by the next request that needs adb.
  if (options.prepareAdb === true) {
    requireAdbExecutable(log).catch(error => {
      log(error instanceof Error ? error.message : String(error))
    })
  }

  // `adb-bridge games add` used to end with "Restart the bridge for it to pick
  // this up" -- for a bridge that is often a hidden sign-in process the user
  // cannot find to restart. The running bridge follows the list instead.
  let lastIds = JSON.stringify(initial.map(p => p.id))
  let syncing = false
  const watcher = options.watchConfig === true
    ? setInterval(async () => {
      if (syncing) return
      const ids = readEnabledGameIds()
      const key = JSON.stringify(ids)
      syncing = true
      try {
        // A game that failed because something held its port starts once the
        // port is free -- the failure message promises exactly that.
        if (key === lastIds) {
          for (const id of failed) {
            const profile = profiles.get(id)
            if (profile && await portIsFree(options.port ?? profile.port)) {
              if (await startOne(profile)) log(`Now serving ${profile.name} (${profile.port}).`)
            }
          }
          return
        }
        lastIds = key
        failed.clear()
        for (const [id, bridge] of running) {
          if (!ids.includes(id)) {
            await bridge.close()
            running.delete(id)
            log(`Stopped serving ${bridge.profile.name}.`)
          }
        }
        const added = resolveProfiles(ids.filter(id => !running.has(id)))
        const clash = findPortConflicts([...running.values()].map(b => b.profile).concat(added))
        if (clash.length > 0) {
          log(`Not starting new games: ${clash.join('; ')}.`)
          return
        }
        for (const profile of added) {
          if (await startOne(profile)) log(`Now serving ${profile.name} (${profile.port}).`)
        }
      } finally {
        syncing = false
      }
    }, CONFIG_POLL_MS)
    : null

  async function close() {
    if (watcher) clearInterval(watcher)
    await Promise.all([...running.values()].map(bridge => bridge.close()))
    running.clear()
  }

  return { bridges: serving, serving, failed: notStarted, profiles: initial, running, close }
}
