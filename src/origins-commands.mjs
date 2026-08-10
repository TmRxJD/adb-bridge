import { loadAllGameProfiles } from './games/registry.mjs'
import { addExtraOrigin, effectiveOrigins, readExtraOrigins, removeExtraOrigin } from './origins.mjs'

/** `adb-bridge origins ...` */

function resolveProfile(gameId, log) {
  const profile = loadAllGameProfiles().profiles.get(String(gameId || '').toLowerCase())
  if (!profile) {
    log(`No game called "${gameId}". Run \`adb-bridge games list\` to see what is available.`)
    return null
  }
  return profile
}

function listOrigins(gameId, log) {
  const { profiles } = loadAllGameProfiles()
  const targets = gameId ? [resolveProfile(gameId, log)].filter(Boolean) : [...profiles.values()]
  if (targets.length === 0) return 1

  for (const profile of targets) {
    const extras = readExtraOrigins(profile.id)
    log(`\n${profile.name} (${profile.id}) — port ${profile.port}`)
    for (const origin of profile.allowedOrigins) log(`    ${origin}`)
    for (const origin of extras) log(`    ${origin}  (yours)`)
    if (extras.length === 0) {
      log(`    …add another with: adb-bridge origins add ${profile.id} <origin>`)
    }
  }
  return 0
}

/** @returns {number} Process exit code. */
export function runOriginsCommand(argv, log = console.log) {
  const [action, gameId, origin] = argv

  switch (action) {
    case undefined:
    case 'list':
      return listOrigins(gameId, log)

    case 'add': {
      if (!gameId || !origin) {
        log('Usage: adb-bridge origins add <game> <origin>')
        log('   eg: adb-bridge origins add thetower https://my-mirror.example')
        return 1
      }
      const profile = resolveProfile(gameId, log)
      if (!profile) return 1
      try {
        addExtraOrigin(profile.id, origin)
      } catch (error) {
        log(error.message)
        return 1
      }
      log(`${profile.name} will now accept connections from ${origin}.`)
      log('This takes effect immediately; no restart needed.')
      return 0
    }

    case 'remove':
    case 'rm': {
      if (!gameId || !origin) {
        log('Usage: adb-bridge origins remove <game> <origin>')
        return 1
      }
      const profile = resolveProfile(gameId, log)
      if (!profile) return 1
      if (profile.allowedOrigins.includes(origin)) {
        // Removing one of a game's own sites would break that site with no
        // obvious cause. Editing the profile is the deliberate way to do it.
        log(`${origin} is one of ${profile.name}'s built-in origins and cannot be removed here.`)
        log(`To change those, put your own ${profile.id}.json in ~/.adb-bridge/games/.`)
        return 1
      }
      removeExtraOrigin(profile.id, origin)
      log(`${profile.name} will no longer accept connections from ${origin}.`)
      return 0
    }

    default:
      log(`Unknown command "origins ${action}". Expected list, add or remove.`)
      return 1
  }
}

export { effectiveOrigins }
