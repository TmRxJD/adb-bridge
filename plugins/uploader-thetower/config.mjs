import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * This uploader's own settings.
 *
 * They live per-game rather than in the bridge's shared config, which is what
 * the single-game bridge did. With one bridge serving several games, a shared
 * "auto upload" flag would mean turning it on for The Tower turned it on for
 * every other game too.
 */
export function uploaderDir() {
  const home = process.env.ADB_BRIDGE_HOME || path.join(os.homedir(), '.adb-bridge')
  return path.join(home, 'uploaders', 'thetower')
}

function configPath() {
  return path.join(uploaderDir(), 'config.json')
}

const DEFAULTS = Object.freeze({
  autoUpload: false,
  // Which kinds of data may be uploaded. Runs are the point of the feature;
  // everything else is opt-in.
  domains: ['runs'],
})

export function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS }
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch }
  fs.mkdirSync(uploaderDir(), { recursive: true })
  const target = configPath()
  // Write-then-rename: a crash midway must not leave a truncated file that
  // reads as "auto upload off" without the user having changed anything.
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
  fs.renameSync(tmp, target)
  return next
}

export function isAutoUploadEnabled() {
  return readConfig().autoUpload === true
}

export function setAutoUploadEnabled(enabled) {
  return writeConfig({ autoUpload: Boolean(enabled) })
}

export function getUploadDomains() {
  const domains = readConfig().domains
  return Array.isArray(domains) ? domains : [...DEFAULTS.domains]
}

export function setUploadDomains(domains) {
  return writeConfig({ domains: Array.isArray(domains) ? domains : [] })
}
