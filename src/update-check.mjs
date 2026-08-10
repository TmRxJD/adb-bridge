import { spawnSync } from 'node:child_process'
import { isAutoUpdateEnabled } from './bridge-config.mjs'

const REGISTRY_URL = 'https://registry.npmjs.org/tracker-bridge/latest'
const PACKAGE_NAME = 'tracker-bridge'
/** Env guard set on the re-spawned process so the fresh copy never re-checks and loops. */
export const SKIP_UPDATE_ENV = 'TRACKER_BRIDGE_SKIP_UPDATE_CHECK'
const DEFAULT_TIMEOUT_MS = 3500

/** Parse "1.4.0" → [1, 4, 0], ignoring any pre-release / build suffix. */
function parseVersion(value) {
  const core = String(value || '').trim().split(/[-+]/, 1)[0]
  const parts = core.split('.').map(part => Number.parseInt(part, 10))
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null
  return parts
}

/** @returns {number} >0 when a is newer than b, <0 when older, 0 when equal/unknown. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

/** Fetch the latest published version from npm, or null on any failure / timeout. */
export async function fetchLatestPublishedVersion(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    const body = await response.json()
    const version = typeof body?.version === 'string' ? body.version.trim() : ''
    return version || null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * True when the update check should be skipped entirely (opt-out flag or the re-exec guard).
 * Note: a non-TTY is NOT skipped when auto-update is on — background/daemon runs should still
 * pick up new versions; they just cannot prompt.
 */
export function shouldSkipUpdateCheck(options = {}) {
  if (options.noUpdate) return true
  if (process.env[SKIP_UPDATE_ENV] === '1') return true
  return false
}

/**
 * Re-run the bridge from the just-downloaded latest version, inheriting the terminal so the
 * user sees the normal first-run flow. Passes through the original CLI args and marks the
 * child so it does not re-check for updates.
 * @returns {boolean} true when the child ran (caller should exit afterwards)
 */
export function runLatestBridge(argv = []) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const result = spawnSync(npx, ['-y', `${PACKAGE_NAME}@latest`, ...argv], {
    stdio: 'inherit',
    env: { ...process.env, [SKIP_UPDATE_ENV]: '1' },
  })
  return result.status !== null || result.error == null
}

/**
 * Check npm for a newer bridge and hand off to it.
 *
 * Auto-update is ON by default (`~/.local-adb-bridge/config.json`): the bridge updates itself
 * and prints a notice. With auto-update turned off it only notifies that an update exists —
 * except on a TTY, where it still offers the choice. Any network failure is swallowed silently
 * so an offline machine starts normally.
 *
 * @param {{ currentVersion: string, argv?: string[], log?: (msg: string) => void,
 *   ask?: (question: string) => Promise<boolean>, noUpdate?: boolean }} params
 * @returns {Promise<boolean>} true when a handoff happened (caller should stop and exit)
 */
export async function maybeUpdateBridge(params) {
  const { currentVersion, argv = [], log = console.log, ask, noUpdate } = params
  if (shouldSkipUpdateCheck({ noUpdate })) return false

  const latest = await fetchLatestPublishedVersion()
  if (!latest || compareVersions(latest, currentVersion) <= 0) return false

  const autoUpdate = isAutoUpdateEnabled()

  if (!autoUpdate) {
    log('')
    log(`A newer Tracker Bridge is available: ${currentVersion} → ${latest}.`)
    // Auto-update is off, so never update silently — ask if we can, otherwise just notify.
    const accepted = ask && process.stdin.isTTY ? await ask('Update now?') : false
    if (!accepted) {
      log(`Update anytime with: npx ${PACKAGE_NAME}@latest`)
      log('(Re-enable automatic updates with: npx tracker-bridge --auto-update)')
      return false
    }
  } else {
    log('')
    log(`Updating Tracker Bridge ${currentVersion} → ${latest} (automatic updates are on)…`)
    log('Turn this off anytime with: npx tracker-bridge --no-auto-update')
  }

  const handedOff = runLatestBridge(argv)
  if (!handedOff) {
    log('Automatic update failed to launch. Run this manually to update:')
    log(`  npx ${PACKAGE_NAME}@latest`)
    return false
  }
  return true
}
