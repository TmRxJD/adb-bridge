import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * This uploader's own settings.
 *
 * They live per-game rather than in the bridge's shared config. With one bridge
 * serving several games, a shared "auto upload" flag -- or a shared list of
 * Tower data types -- would apply one game's choices to every other game.
 */
export function uploaderDir() {
  const home = process.env.ADB_BRIDGE_HOME || path.join(os.homedir(), '.adb-bridge')
  return path.join(home, 'uploaders', 'thetower')
}

function configPath() {
  return path.join(uploaderDir(), 'config.json')
}

/** Every kind of data this plugin can upload, in import-page tab order. */
export const UPLOAD_DOMAINS = Object.freeze([
  { value: 'runs', label: 'Battle Reports' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'labs', label: 'Labs' },
  { value: 'uw', label: 'Ultimate Weapons' },
  { value: 'modules', label: 'Modules' },
  { value: 'cards', label: 'Cards' },
  { value: 'vault', label: 'Vault' },
  { value: 'bots', label: 'Bots' },
  { value: 'guardian', label: 'Guardians' },
  { value: 'relics', label: 'Relics' },
  { value: 'lifetime', label: 'Lifetime' },
].map(Object.freeze))

export const RUN_TYPES = Object.freeze([
  { value: 'farming', label: 'Farming runs' },
  { value: 'tournament', label: 'Tournament runs' },
].map(Object.freeze))

const DOMAIN_IDS = UPLOAD_DOMAINS.map(domain => domain.value)
const RUN_TYPE_IDS = RUN_TYPES.map(type => type.value)

/**
 * Declared to the bridge, which relays it to the tray's settings window. Labels
 * only: the window draws exactly these, with no knowledge of the game.
 */
export const SETTINGS_SCHEMA = Object.freeze([
  { key: 'domains', type: 'multiselect', label: 'Upload these', options: UPLOAD_DOMAINS },
  { key: 'runTypes', type: 'multiselect', label: 'Run types', options: RUN_TYPES },
  { key: 'minWave', type: 'number', label: 'Minimum wave', min: 0 },
  { key: 'farmingTierMin', type: 'number', label: 'Lowest farming tier', min: 1, max: 99, optional: true },
  { key: 'farmingTierMax', type: 'number', label: 'Highest farming tier', min: 1, max: 99, optional: true },
  { key: 'coinsBelowMedianPct', type: 'number', label: 'Coins % below median', min: 1, max: 100, optional: true },
  { key: 'coinsAboveMedianPct', type: 'number', label: 'Coins % above median', min: 1, max: 10_000, optional: true },
].map(Object.freeze))

const DEFAULTS = Object.freeze({
  autoUpload: false,
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

function resolveOptionalInt(value, min, max) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(max, Math.max(min, Math.round(number)))
}

function pickKnown(value, known) {
  return Array.isArray(value) ? known.filter(id => value.includes(id)) : [...known]
}

/**
 * Sanitise settings. Anything unreadable falls back to "no filter" and "upload
 * everything", never to "filter everything" -- a bad value must not silently
 * stop uploads.
 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  let tierMin = resolveOptionalInt(source.farmingTierMin, 1, 99)
  let tierMax = resolveOptionalInt(source.farmingTierMax, 1, 99)
  if (tierMin !== null && tierMax !== null && tierMin > tierMax) [tierMin, tierMax] = [tierMax, tierMin]
  return {
    domains: pickKnown(source.domains, DOMAIN_IDS),
    runTypes: pickKnown(source.runTypes, RUN_TYPE_IDS),
    minWave: resolveOptionalInt(source.minWave, 0, 1_000_000) ?? 0,
    farmingTierMin: tierMin,
    farmingTierMax: tierMax,
    coinsBelowMedianPct: resolveOptionalInt(source.coinsBelowMedianPct, 1, 100),
    coinsAboveMedianPct: resolveOptionalInt(source.coinsAboveMedianPct, 1, 10_000),
  }
}

/** Domains that existed while the bridge core stored an enabled `uploadDomains` list. */
const LEGACY_LISTED_DOMAINS = new Set(['runs', 'workshop', 'labs', 'cards', 'modules', 'bots', 'guardian', 'vault', 'uw'])

function legacyCoreConfigPath() {
  return process.env.ADB_BRIDGE_LEGACY_CONFIG_PATH || path.join(os.homedir(), '.local-adb-bridge', 'config.json')
}

/**
 * Before plugin 0.3.0 these choices lived in the bridge core's shared config.
 * Read them once, so moving them here loses nothing a user set.
 */
function readLegacyCoreSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyCoreConfigPath(), 'utf8'))
    let disabledDomains
    if (Array.isArray(parsed.disabledDomains)) {
      disabledDomains = parsed.disabledDomains
    } else if (Array.isArray(parsed.uploadDomains)) {
      const enabled = new Set(parsed.uploadDomains)
      disabledDomains = DOMAIN_IDS.filter(id => LEGACY_LISTED_DOMAINS.has(id) && !enabled.has(id))
    }
    return { disabledDomains, filters: parsed.uploadFilters }
  } catch {
    return {}
  }
}

/**
 * Current settings. Domains are stored as opt-outs, so a data type added in a
 * later release is on for everyone while their choices still hold.
 */
export function readSettings() {
  const config = readConfig()
  const legacy = config.disabledDomains === undefined || config.filters === undefined ? readLegacyCoreSettings() : {}
  const disabled = new Set(
    Array.isArray(config.disabledDomains) ? config.disabledDomains : (legacy.disabledDomains ?? []),
  )
  const filters = config.filters && typeof config.filters === 'object' ? config.filters : (legacy.filters ?? {})
  return normalizeSettings({ ...filters, domains: DOMAIN_IDS.filter(id => !disabled.has(id)) })
}

/** Merge, validate and persist; returns every value. */
export function writeSettings(patch) {
  const next = normalizeSettings({ ...readSettings(), ...(patch && typeof patch === 'object' ? patch : {}) })
  const { domains, ...filters } = next
  writeConfig({ disabledDomains: DOMAIN_IDS.filter(id => !domains.includes(id)), filters })
  return next
}
