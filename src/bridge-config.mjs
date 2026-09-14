import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Same root the platform-tools installer already uses. */
const CONFIG_DIR = path.join(os.homedir(), '.local-adb-bridge')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

/**
 * Auto-update is ON out of the box; the bridge updates itself and says so.
 * Auto-upload is not here: each game's uploader plugin owns it, so turning it on
 * for one game cannot turn it on for another.
 */
export const DEFAULT_CONFIG = Object.freeze({
  autoUpdate: true,
  /** Reconnect to the last device automatically when the import page opens. */
  autoConnect: true,
  /** 'emulator' | 'usb' | 'mac' — whichever connect the user last succeeded with. */
  lastDevice: null,
  /**
   * Opt-OUTs, not opt-ins.
   *
   * Storing the enabled list meant a config written before a domain existed
   * could never enable it — relics and lifetime stayed invisible to anyone with
   * an older config. Recording only what the user turned off means a new domain
   * is on by default for everyone, and their choices still persist.
   */
  disabledDomains: [],
  /**
   * 'normal' prints uploads, errors and link changes. 'verbose' adds every pull
   * step and every scan. A background process that narrates each minute buries
   * the one line that matters.
   */
  logLevel: 'normal',
  /** How often an emulator save is checked, since there is no local file to watch. */
  scanIntervalSeconds: 60,
  /** Which runs background uploads send. Defaults send everything, as before. */
  uploadFilters: {
    runTypes: ['farming', 'tournament'],
    minWave: 0,
    farmingTierMin: null,
    farmingTierMax: null,
    coinsBelowMedianPct: null,
    coinsAboveMedianPct: null,
  },
})

export const RUN_TYPES = Object.freeze(['farming', 'tournament'])

function resolveOptionalInt(value, min, max) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(max, Math.max(min, Math.round(number)))
}

/**
 * Sanitise stored or incoming upload filters. Anything unreadable falls back to
 * "no filter", never to "filter everything" -- a bad value must not silently
 * stop uploads.
 */
export function normalizeUploadFilters(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const runTypes = Array.isArray(source.runTypes)
    ? RUN_TYPES.filter(type => source.runTypes.includes(type))
    : [...RUN_TYPES]
  let tierMin = resolveOptionalInt(source.farmingTierMin, 1, 99)
  let tierMax = resolveOptionalInt(source.farmingTierMax, 1, 99)
  if (tierMin !== null && tierMax !== null && tierMin > tierMax) [tierMin, tierMax] = [tierMax, tierMin]
  return {
    runTypes,
    minWave: resolveOptionalInt(source.minWave, 0, 1_000_000) ?? 0,
    farmingTierMin: tierMin,
    farmingTierMax: tierMax,
    coinsBelowMedianPct: resolveOptionalInt(source.coinsBelowMedianPct, 1, 100),
    coinsAboveMedianPct: resolveOptionalInt(source.coinsAboveMedianPct, 1, 10_000),
  }
}

export const LOG_LEVELS = Object.freeze(['normal', 'verbose'])
/** Below this, each scan spawns adb often enough to be felt on a slow machine. */
export const MIN_SCAN_INTERVAL_SECONDS = 15
export const MAX_SCAN_INTERVAL_SECONDS = 3600

function resolveScanIntervalSeconds(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return DEFAULT_CONFIG.scanIntervalSeconds
  return Math.min(MAX_SCAN_INTERVAL_SECONDS, Math.max(MIN_SCAN_INTERVAL_SECONDS, Math.round(seconds)))
}

export function getConfigPath() {
  return CONFIG_PATH
}

/** @returns {{ autoUpdate: boolean }} stored prefs merged over the defaults. */
export function readBridgeConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_CONFIG }
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      autoUpdate:
        typeof parsed.autoUpdate === 'boolean' ? parsed.autoUpdate : DEFAULT_CONFIG.autoUpdate,
      autoConnect:
        typeof parsed.autoConnect === 'boolean' ? parsed.autoConnect : DEFAULT_CONFIG.autoConnect,
      lastDevice:
        typeof parsed.lastDevice === 'string' ? parsed.lastDevice : DEFAULT_CONFIG.lastDevice,
      disabledDomains: resolveDisabledDomains(parsed),
      logLevel: LOG_LEVELS.includes(parsed.logLevel) ? parsed.logLevel : DEFAULT_CONFIG.logLevel,
      scanIntervalSeconds: parsed.scanIntervalSeconds == null
        ? DEFAULT_CONFIG.scanIntervalSeconds
        : resolveScanIntervalSeconds(parsed.scanIntervalSeconds),
      uploadFilters: normalizeUploadFilters(parsed.uploadFilters ?? DEFAULT_CONFIG.uploadFilters),
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** Merge and persist. Failures are non-fatal — the bridge still runs. */
export function writeBridgeConfig(patch) {
  const next = { ...readBridgeConfig(), ...patch }
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    // Keep the bridge usable on read-only / locked-down home dirs.
  }
  return next
}

export function isAutoUpdateEnabled() {
  return readBridgeConfig().autoUpdate === true
}

export function setAutoUpdateEnabled(enabled) {
  return writeBridgeConfig({ autoUpdate: Boolean(enabled) })
}

export function isAutoConnectEnabled() {
  return readBridgeConfig().autoConnect === true
}

export function setAutoConnectEnabled(enabled) {
  return writeBridgeConfig({ autoConnect: Boolean(enabled) })
}

export function getLastDevice() {
  return readBridgeConfig().lastDevice ?? null
}

export function setLastDevice(device) {
  return writeBridgeConfig({ lastDevice: device ? String(device) : null })
}

/** Every domain the bridge can upload, in import-page tab order. */
export const ALL_UPLOAD_DOMAINS = Object.freeze([
  'runs', 'workshop', 'labs', 'uw', 'modules',
  'cards', 'vault', 'bots', 'guardian', 'relics', 'lifetime',
])

/**
 * Migrate a legacy `uploadDomains` (enabled list) to opt-outs, so an existing
 * config keeps the user's choices without freezing them out of new domains.
 */
function resolveDisabledDomains(parsed) {
  if (Array.isArray(parsed.disabledDomains)) {
    return parsed.disabledDomains.filter(d => typeof d === 'string')
  }
  if (Array.isArray(parsed.uploadDomains)) {
    const enabled = new Set(parsed.uploadDomains.filter(d => typeof d === 'string'))
    // Only treat a domain as disabled if it existed when that config was
    // written; anything newer stays enabled.
    return ALL_UPLOAD_DOMAINS.filter(d => !enabled.has(d) && KNOWN_LEGACY_DOMAINS.has(d))
  }
  return []
}

/** Domains that existed while `uploadDomains` was still the stored shape. */
const KNOWN_LEGACY_DOMAINS = new Set([
  'runs', 'workshop', 'labs', 'cards', 'modules', 'bots', 'guardian', 'vault', 'uw',
])

export function getUploadDomains() {
  const disabled = new Set(readBridgeConfig().disabledDomains ?? [])
  return ALL_UPLOAD_DOMAINS.filter(domain => !disabled.has(domain))
}

export function setUploadDomains(domains) {
  const enabled = new Set(Array.isArray(domains) ? domains.filter(d => typeof d === 'string') : [])
  return writeBridgeConfig({
    disabledDomains: ALL_UPLOAD_DOMAINS.filter(domain => !enabled.has(domain)),
  })
}

export function getLogLevel() {
  return readBridgeConfig().logLevel
}

export function setLogLevel(level) {
  return writeBridgeConfig({ logLevel: LOG_LEVELS.includes(level) ? level : DEFAULT_CONFIG.logLevel })
}

export function getUploadFilters() {
  return readBridgeConfig().uploadFilters
}

export function setUploadFilters(filters) {
  return writeBridgeConfig({ uploadFilters: normalizeUploadFilters(filters) })
}

export function getScanIntervalSeconds() {
  return readBridgeConfig().scanIntervalSeconds
}

export function setScanIntervalSeconds(seconds) {
  return writeBridgeConfig({ scanIntervalSeconds: resolveScanIntervalSeconds(seconds) })
}

