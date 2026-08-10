import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeGameProfile, ProfileError } from './profile-schema.mjs'

const BUILTIN_DIR = fileURLToPath(new URL('./builtin/', import.meta.url))

/** Everything user-owned lives here: config, user profiles, linked accounts. */
export function configDir() {
  return process.env.ADB_BRIDGE_HOME || path.join(os.homedir(), '.adb-bridge')
}

/** Drop a JSON file here to add a game. No code, nothing to publish. */
export function userGamesDir() {
  return path.join(configDir(), 'games')
}

function readProfileFile(filePath, builtin) {
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new ProfileError(`could not read ${filePath}: ${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    // Hand-written JSON, so say where it broke rather than "unexpected token".
    throw new ProfileError(`${filePath} is not valid JSON: ${error.message}`)
  }
  return normalizeGameProfile(parsed, { source: filePath, builtin })
}

function listJsonFiles(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // Absent directory just means no profiles from there.
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => path.join(dir, entry.name))
    .sort()
}

/**
 * All known profiles, built-in first.
 *
 * A user profile with the same id as a built-in replaces it. That is
 * deliberate: it is how someone fixes a save path or an origin for themselves
 * when the game changes and a release has not caught up yet.
 *
 * @returns {{ profiles: Map<string, object>, errors: Array<{ source: string, message: string }> }}
 */
export function loadAllGameProfiles() {
  const profiles = new Map()
  const errors = []

  for (const [dir, builtin] of [[BUILTIN_DIR, true], [userGamesDir(), false]]) {
    for (const filePath of listJsonFiles(dir)) {
      try {
        const profile = readProfileFile(filePath, builtin)
        profiles.set(profile.id, profile)
      } catch (error) {
        // One broken user profile must not stop the other games from running.
        errors.push({ source: filePath, message: error.message })
      }
    }
  }

  return { profiles, errors }
}

/** @returns {object|null} */
export function findGameProfile(id) {
  return loadAllGameProfiles().profiles.get(String(id || '').toLowerCase()) ?? null
}

/**
 * Ports must be unique: two games sharing one would mean whichever bound first
 * silently answers for both, serving the wrong game's save to a site.
 *
 * @param {object[]} profiles
 * @returns {string[]} Human-readable conflict descriptions, empty when fine.
 */
export function findPortConflicts(profiles) {
  const byPort = new Map()
  for (const profile of profiles) {
    const existing = byPort.get(profile.port)
    if (existing) existing.push(profile)
    else byPort.set(profile.port, [profile])
  }
  const conflicts = []
  for (const [port, group] of byPort) {
    if (group.length > 1) {
      conflicts.push(`port ${port} is claimed by ${group.map(p => p.id).join(' and ')}`)
    }
  }
  return conflicts
}
