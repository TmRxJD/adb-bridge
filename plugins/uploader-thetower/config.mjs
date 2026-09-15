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
  { value: 'runs', label: 'Battle reports' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'labs', label: 'Labs' },
  { value: 'uw', label: 'Ultimate weapons' },
  { value: 'modules', label: 'Modules' },
  { value: 'cards', label: 'Cards' },
  { value: 'vault', label: 'Vault' },
  { value: 'bots', label: 'Bots' },
  { value: 'guardian', label: 'Guardians' },
  { value: 'relics', label: 'Relics' },
  { value: 'lifetime', label: 'Lifetime' },
].map(Object.freeze))

const DOMAIN_IDS = UPLOAD_DOMAINS.map(domain => domain.value)

/**
 * Declared to the bridge, which relays it to the tray's settings window and the
 * site's bridge dialog; both draw exactly this. Rules read as sentences under
 * their heading ("Skip farming runs that" / "ended before wave 100").
 *
 * Farming and tournament runs have separate rules: tournament difficulty is a
 * league, not a plain tier, and only a tournament's highest wave counts.
 */
export const SETTINGS_SCHEMA = Object.freeze([
  { key: 'domains', type: 'multiselect', label: 'Upload these', options: UPLOAD_DOMAINS },
  { key: 'farmingSection', type: 'section', label: 'Skip farming runs that' },
  { key: 'farmingMinWaveOn', type: 'rule', label: 'ended before wave', inputs: [{ key: 'farmingMinWave', min: 1 }] },
  {
    key: 'farmingTierOn',
    type: 'rule',
    label: 'were played outside tier',
    inputs: [{ key: 'farmingTierMin', min: 1, max: 99 }, { key: 'farmingTierMax', min: 1, max: 99 }],
    joiner: 'to',
  },
  {
    key: 'coinsOutlierOn',
    type: 'rule',
    label: 'earned coins more than',
    inputs: [{ key: 'coinsOutlierPct', min: 1, max: 1000 }],
    suffix: '% from your median for that tier',
  },
  { key: 'tournamentSection', type: 'section', label: 'Tournament runs' },
  { key: 'tournamentKeepBest', type: 'rule', label: 'Keep only the highest wave of each tournament' },
  { key: 'tournamentMinWaveOn', type: 'rule', label: 'Skip runs that ended before wave', inputs: [{ key: 'tournamentMinWave', min: 1 }] },
].map(Object.freeze))

const DEFAULTS = Object.freeze({
  autoUpload: false,
})

/** Rule values. Every rule is off by default: a fresh install uploads everything. */
const DEFAULT_RULES = Object.freeze({
  farmingMinWaveOn: false,
  farmingMinWave: 100,
  farmingTierOn: false,
  farmingTierMin: null,
  farmingTierMax: null,
  coinsOutlierOn: false,
  coinsOutlierPct: 50,
  tournamentKeepBest: false,
  tournamentMinWaveOn: false,
  tournamentMinWave: 100,
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
 * Filters saved before the rules existed (plugin 0.3.x): a flat `minWave`, a
 * tier range, and separate below/above coin percentages, all applying to every
 * run. Map them onto the farming rules so nothing a user set is lost. The old
 * run-type choice has no successor and is dropped.
 */
function upgradeLegacyFilters(source) {
  if ('farmingMinWaveOn' in source || 'coinsOutlierOn' in source || 'farmingTierOn' in source) return source
  const upgraded = { ...source }
  const legacyMinWave = resolveOptionalInt(source.minWave, 0, 1_000_000)
  if (legacyMinWave) {
    upgraded.farmingMinWaveOn = true
    upgraded.farmingMinWave = legacyMinWave
  }
  if (source.farmingTierMin != null || source.farmingTierMax != null) upgraded.farmingTierOn = true
  const legacyCoins = resolveOptionalInt(source.coinsBelowMedianPct ?? source.coinsAboveMedianPct, 1, 1000)
  if (legacyCoins) {
    upgraded.coinsOutlierOn = true
    upgraded.coinsOutlierPct = legacyCoins
  }
  return upgraded
}

/**
 * Sanitise settings. Anything unreadable falls back to the default -- rules
 * off, everything uploaded -- never to "skip everything".
 */
export function normalizeSettings(raw) {
  const source = upgradeLegacyFilters(raw && typeof raw === 'object' ? raw : {})
  const on = key => (typeof source[key] === 'boolean' ? source[key] : DEFAULT_RULES[key])
  const wave = key => resolveOptionalInt(source[key], 1, 1_000_000) ?? DEFAULT_RULES[key]
  const tier = key => resolveOptionalInt(source[key], 1, 99)
  let farmingTierMin = tier('farmingTierMin')
  let farmingTierMax = tier('farmingTierMax')
  if (farmingTierMin !== null && farmingTierMax !== null && farmingTierMin > farmingTierMax) {
    [farmingTierMin, farmingTierMax] = [farmingTierMax, farmingTierMin]
  }
  return {
    domains: pickKnown(source.domains, DOMAIN_IDS),
    farmingMinWaveOn: on('farmingMinWaveOn'),
    farmingMinWave: wave('farmingMinWave'),
    farmingTierOn: on('farmingTierOn'),
    farmingTierMin,
    farmingTierMax,
    coinsOutlierOn: on('coinsOutlierOn'),
    coinsOutlierPct: resolveOptionalInt(source.coinsOutlierPct, 1, 1000) ?? DEFAULT_RULES.coinsOutlierPct,
    tournamentKeepBest: on('tournamentKeepBest'),
    tournamentMinWaveOn: on('tournamentMinWaveOn'),
    tournamentMinWave: wave('tournamentMinWave'),
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
