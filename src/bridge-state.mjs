import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './games/registry.mjs'

/**
 * Which games this machine's bridge serves.
 *
 * This one file is what makes "add CIFI to the bridge I already have" work
 * rather than installing a second bridge: enabling a game is an edit here, and
 * the next start picks it up. Nothing else about the install changes -- same
 * autostart entry, same update check, same adb server.
 */
function stateFile() {
  return path.join(configDir(), 'bridge.json')
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeState(next) {
  const dir = configDir()
  fs.mkdirSync(dir, { recursive: true })
  const target = stateFile()
  // Write-then-rename: a crash midway through must not leave a truncated file
  // that reads as "no games enabled" and silently stops serving on next start.
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, target)
}

/** @returns {string[]} */
export function readEnabledGameIds() {
  const games = readState().games
  if (!Array.isArray(games)) return []
  return games.filter(id => typeof id === 'string' && id.length > 0)
}

/** @returns {string[]} The full list after the change. */
export function enableGame(id) {
  const current = readEnabledGameIds()
  if (current.includes(id)) return current
  const next = [...current, id]
  writeState({ ...readState(), games: next })
  return next
}

/** @returns {string[]} The full list after the change. */
export function disableGame(id) {
  const next = readEnabledGameIds().filter(existing => existing !== id)
  writeState({ ...readState(), games: next })
  return next
}

export function isGameEnabled(id) {
  return readEnabledGameIds().includes(id)
}

/**
 * True when this machine already has a configured bridge.
 *
 * The installer and `games add` use this to extend what is there instead of
 * standing up a second install.
 */
export function bridgeIsConfigured() {
  return fs.existsSync(stateFile())
}

export { stateFile as bridgeStateFile }
