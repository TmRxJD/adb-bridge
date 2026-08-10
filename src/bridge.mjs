import { loadAllGameProfiles, findPortConflicts } from './games/registry.mjs'
import { readEnabledGameIds } from './bridge-state.mjs'
import { startGameBridge } from './game-bridge.mjs'
import { loadUploaderForProfile } from './upload/uploader-plugin.mjs'

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
export async function startBridge(options = {}) {
  const log = options.log ?? console.log
  const { profiles, errors } = loadAllGameProfiles()

  // A broken user-written profile is worth saying out loud -- it was added on
  // purpose, and silence would look like the file was ignored.
  for (const problem of errors) {
    log(`Ignoring game profile: ${problem.message}`)
  }

  const enabledIds = options.gameIds ?? readEnabledGameIds()
  const enabled = []
  for (const id of enabledIds) {
    const profile = profiles.get(id)
    if (!profile) {
      log(`No game profile named "${id}"; run \`adb-bridge games list\` to see what is available.`)
      continue
    }
    enabled.push(profile)
  }

  if (enabled.length === 0) {
    log('No games are enabled. Run `adb-bridge games add <id>` to enable one.')
    return { bridges: [], profiles: [] }
  }

  // Two games on one port would mean whichever bound first silently answers for
  // both -- serving one game's save to the other's website.
  const conflicts = findPortConflicts(enabled)
  if (conflicts.length > 0) {
    throw new Error(`Cannot start: ${conflicts.join('; ')}.`)
  }

  const bridges = []
  for (const profile of enabled) {
    const { uploader } = await loadUploaderForProfile(profile, log)
    bridges.push(startGameBridge(profile, { ...options, uploader }))
  }

  log(
    `adb-bridge serving ${bridges.length} game(s): `
    + bridges.map(b => `${b.profile.name} (${b.port})`).join(', '),
  )
  return { bridges, profiles: enabled }
}
