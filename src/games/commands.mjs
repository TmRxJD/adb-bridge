import { loadAllGameProfiles, userGamesDir } from './registry.mjs'
import {
  bridgeIsConfigured,
  disableGame,
  enableGame,
  isGameEnabled,
  readEnabledGameIds,
} from '../bridge-state.mjs'

/**
 * `adb-bridge games ...`
 *
 * `add` is the command that replaces installing a second bridge, so it says out
 * loud which of the two things it did -- joined the bridge that was already
 * here, or set one up.
 */

function formatRow(profile, enabled) {
  const mark = enabled ? '*' : ' '
  const origin = profile.builtin ? '' : '  (yours)'
  return ` ${mark} ${profile.id.padEnd(12)} ${profile.name.padEnd(22)} port ${profile.port}${origin}`
}

export function listGames(log = console.log) {
  const { profiles, errors } = loadAllGameProfiles()
  const enabled = new Set(readEnabledGameIds())

  if (profiles.size === 0) {
    log('No game profiles found.')
    return 0
  }

  log('Games (* = enabled on this machine):\n')
  for (const profile of profiles.values()) {
    log(formatRow(profile, enabled.has(profile.id)))
  }

  if (enabled.size === 0) {
    log('\nNothing is enabled yet. Run `adb-bridge games add <id>`.')
  }

  for (const problem of errors) {
    log(`\nCould not load ${problem.source}:\n  ${problem.message}`)
  }

  log(`\nAdd your own game by putting a JSON profile in:\n  ${userGamesDir()}`)
  return errors.length > 0 ? 1 : 0
}

export function addGame(id, log = console.log) {
  const { profiles } = loadAllGameProfiles()
  const profile = profiles.get(String(id || '').toLowerCase())

  if (!profile) {
    log(`No game called "${id}".`)
    log('Run `adb-bridge games list` to see what is available.')
    return 1
  }

  if (isGameEnabled(profile.id)) {
    log(`${profile.name} is already enabled (port ${profile.port}).`)
    return 0
  }

  // Whether a bridge already exists changes what the user needs to do next, so
  // check before enabling rather than after.
  const hadBridge = bridgeIsConfigured()
  const enabled = enableGame(profile.id)

  if (hadBridge) {
    log(`Added ${profile.name} to your existing bridge (port ${profile.port}).`)
    log(`Now serving: ${enabled.join(', ')}.`)
    log('Restart the bridge for it to pick this up.')
  } else {
    log(`Enabled ${profile.name} (port ${profile.port}).`)
    log('Start it with `adb-bridge`.')
  }
  return 0
}

export function removeGame(id, log = console.log) {
  const wanted = String(id || '').toLowerCase()

  if (!isGameEnabled(wanted)) {
    log(`"${id}" is not enabled, so there is nothing to remove.`)
    return 0
  }

  const remaining = disableGame(wanted)
  const { profiles } = loadAllGameProfiles()
  const name = profiles.get(wanted)?.name ?? wanted

  log(`Removed ${name}.`)
  log(
    remaining.length > 0
      ? `Still serving: ${remaining.join(', ')}. Restart the bridge to apply.`
      : 'No games are enabled now; the bridge will serve nothing until you add one.',
  )
  return 0
}

/** @returns {number} Process exit code. */
export function runGamesCommand(argv, log = console.log) {
  const [action, target] = argv

  switch (action) {
    case undefined:
    case 'list':
      return listGames(log)
    case 'add':
      if (!target) {
        log('Usage: adb-bridge games add <id>')
        return 1
      }
      return addGame(target, log)
    case 'remove':
    case 'rm':
      if (!target) {
        log('Usage: adb-bridge games remove <id>')
        return 1
      }
      return removeGame(target, log)
    default:
      log(`Unknown command "games ${action}". Expected list, add or remove.`)
      return 1
  }
}
