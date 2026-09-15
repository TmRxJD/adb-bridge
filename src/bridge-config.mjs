import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Same root the platform-tools installer already uses. */
const CONFIG_DIR = path.join(os.homedir(), '.local-adb-bridge')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

/**
 * Settings shared by every game.
 *
 * Anything about one game -- what it uploads, how its runs are filtered, whether
 * it auto-uploads -- belongs to that game's uploader plugin, which declares it
 * (see upload/settings-schema.mjs). One game's concepts living here is how a
 * Tower-only "upload domains" list once applied to every game on the bridge.
 *
 * Auto-update is ON out of the box; the bridge updates itself and says so.
 */
export const DEFAULT_CONFIG = Object.freeze({
  autoUpdate: true,
  /** Reconnect to the last device automatically when the import page opens. */
  autoConnect: true,
  /** 'emulator' | 'usb' | 'mac' — whichever connect the user last succeeded with. */
  lastDevice: null,
  /**
   * The emulator ADB address ("127.0.0.1:16384") the last successful pull used. Tried
   * first next time, so reconnecting after an emulator restart is one `adb connect`
   * rather than a probe of every known emulator port.
   */
  lastEmulatorHost: null,
  /**
   * 'normal' prints uploads, errors and link changes. 'verbose' adds every pull
   * step and every scan. A background process that narrates each minute buries
   * the one line that matters.
   */
  logLevel: 'normal',
  /** How often an emulator save is checked, since there is no local file to watch. */
  scanIntervalSeconds: 60,
})

export const LOG_LEVELS = Object.freeze(['normal', 'verbose'])
/** Below this, each scan spawns adb often enough to be felt on a slow machine. */
export const MIN_SCAN_INTERVAL_SECONDS = 15
export const MAX_SCAN_INTERVAL_SECONDS = 3600

/** Only a TCP emulator address is worth remembering; anything else reads as none. */
export function normalizeEmulatorHost(value) {
  const host = typeof value === 'string' ? value.trim() : ''
  return /^127\.0\.0\.1:\d{4,5}$/.test(host) ? host : null
}

function resolveScanIntervalSeconds(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return DEFAULT_CONFIG.scanIntervalSeconds
  return Math.min(MAX_SCAN_INTERVAL_SECONDS, Math.max(MIN_SCAN_INTERVAL_SECONDS, Math.round(seconds)))
}

export function getConfigPath() {
  return CONFIG_PATH
}

/** Stored prefs merged over the defaults. Unknown keys in the file are carried through. */
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
      lastEmulatorHost: normalizeEmulatorHost(parsed.lastEmulatorHost),
      logLevel: LOG_LEVELS.includes(parsed.logLevel) ? parsed.logLevel : DEFAULT_CONFIG.logLevel,
      scanIntervalSeconds: parsed.scanIntervalSeconds == null
        ? DEFAULT_CONFIG.scanIntervalSeconds
        : resolveScanIntervalSeconds(parsed.scanIntervalSeconds),
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

export function getLastEmulatorHost() {
  return readBridgeConfig().lastEmulatorHost ?? null
}

/** Remember a host that just worked; writes only when it changed. */
export function setLastEmulatorHost(host) {
  const next = normalizeEmulatorHost(host)
  if (!next || next === getLastEmulatorHost()) return readBridgeConfig()
  return writeBridgeConfig({ lastEmulatorHost: next })
}

export function getLogLevel() {
  return readBridgeConfig().logLevel
}

export function setLogLevel(level) {
  return writeBridgeConfig({ logLevel: LOG_LEVELS.includes(level) ? level : DEFAULT_CONFIG.logLevel })
}

export function getScanIntervalSeconds() {
  return readBridgeConfig().scanIntervalSeconds
}

export function setScanIntervalSeconds(seconds) {
  return writeBridgeConfig({ scanIntervalSeconds: resolveScanIntervalSeconds(seconds) })
}
