import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './games/registry.mjs'

/**
 * Extra origins the user has allowed, per game.
 *
 * A profile's `allowedOrigins` is a baked-in list, and baked-in lists go stale:
 * a site moves domain, someone self-hosts, someone runs the site on a different
 * dev port. Without a way to add one, the only recourse is editing a profile
 * inside node_modules -- and the failure looks like "the bridge is broken"
 * rather than "this origin is not allowed".
 *
 * These are additive. Removing a built-in origin is deliberately not offered:
 * the profile is the source of truth for a game's own sites, and a user profile
 * overriding the built-in already covers wanting a different set entirely.
 */
function originsFile() {
  return path.join(configDir(), 'origins.json')
}

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(originsFile(), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeAll(next) {
  fs.mkdirSync(configDir(), { recursive: true })
  const target = originsFile()
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
  fs.renameSync(tmp, target)
}

/**
 * Reject anything that is not a bare origin.
 *
 * This grants a site the ability to read save files off the machine, so a typo
 * that silently widens access is worse than an error.
 *
 * @returns {string} The normalized origin.
 */
export function normalizeOrigin(input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('An origin is required, e.g. https://example.com')
  if (raw === '*') {
    throw new Error('"*" would let any website read your save files. Add specific origins instead.')
  }

  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`"${raw}" is not a valid origin. Use the full form, e.g. https://example.com`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`"${raw}" must be an http:// or https:// origin.`)
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`"${raw}" must be a bare origin with no path or query, e.g. ${parsed.origin}`)
  }
  return parsed.origin
}

/** @returns {string[]} */
export function readExtraOrigins(gameId) {
  const list = readAll()[gameId]
  return Array.isArray(list) ? list.filter(entry => typeof entry === 'string') : []
}

/** @returns {string[]} The full extra list for the game after the change. */
export function addExtraOrigin(gameId, origin) {
  const normalized = normalizeOrigin(origin)
  const all = readAll()
  const current = readExtraOrigins(gameId)
  if (current.includes(normalized)) return current
  const next = [...current, normalized]
  writeAll({ ...all, [gameId]: next })
  return next
}

/** @returns {string[]} The full extra list for the game after the change. */
export function removeExtraOrigin(gameId, origin) {
  const all = readAll()
  const next = readExtraOrigins(gameId).filter(entry => entry !== String(origin).trim())
  writeAll({ ...all, [gameId]: next })
  return next
}

/**
 * Every origin allowed to reach this game: the profile's own, plus the user's.
 * @returns {string[]}
 */
export function effectiveOrigins(profile) {
  const extras = readExtraOrigins(profile.id)
  return [...new Set([...profile.allowedOrigins, ...extras])]
}
