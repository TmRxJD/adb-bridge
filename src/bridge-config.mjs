import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Same root the platform-tools installer already uses. */
const CONFIG_DIR = path.join(os.homedir(), '.local-adb-bridge')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

/**
 * Auto-update is ON out of the box; the bridge updates itself and says so.
 * Auto-upload is OFF until the user links an account and opts in — it sends data
 * to the cloud, so it must never turn itself on.
 */
export const DEFAULT_CONFIG = Object.freeze({
  autoUpdate: true,
  autoUpload: false,
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
})

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
      autoUpload:
        typeof parsed.autoUpload === 'boolean' ? parsed.autoUpload : DEFAULT_CONFIG.autoUpload,
      autoConnect:
        typeof parsed.autoConnect === 'boolean' ? parsed.autoConnect : DEFAULT_CONFIG.autoConnect,
      lastDevice:
        typeof parsed.lastDevice === 'string' ? parsed.lastDevice : DEFAULT_CONFIG.lastDevice,
      disabledDomains: resolveDisabledDomains(parsed),
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

export function isAutoUploadEnabled() {
  return readBridgeConfig().autoUpload === true
}

export function setAutoUploadEnabled(enabled) {
  return writeBridgeConfig({ autoUpload: Boolean(enabled) })
}
