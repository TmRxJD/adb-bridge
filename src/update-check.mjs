import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { isAutoUpdateEnabled } from './bridge-config.mjs'
import { nodeToolCommand } from './node-tools.mjs'

/**
 * Which package to update from, taken from our own package.json.
 *
 * This was hardcoded to `tracker-bridge` and stayed that way through the
 * rename, so adb-bridge 0.2.1 compared itself against tracker-bridge's 1.8.1,
 * decided it was out of date, and "updated" to the compatibility shim -- which
 * installs adb-bridge and hands back. It could never update itself, and said so
 * on every start.
 *
 * Reading the name and version from the manifest means a rename or a release
 * cannot desynchronise it again; there is nothing here to remember to change.
 */
const require_ = createRequire(import.meta.url)
const manifest = require_('../package.json')
const PACKAGE_NAME = manifest.name
const DISPLAY_NAME = 'ADB Bridge'
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
/** Env guard set on the re-spawned process so the fresh copy never re-checks and loops. */
export const SKIP_UPDATE_ENV = 'ADB_BRIDGE_SKIP_UPDATE_CHECK'
/** Honoured too: a bridge started by an older parent still sets this one. */
const LEGACY_SKIP_UPDATE_ENV = 'TRACKER_BRIDGE_SKIP_UPDATE_CHECK'
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
export async function fetchLatestPublishedVersion(timeoutMs = DEFAULT_TIMEOUT_MS, packageName = PACKAGE_NAME) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const url = packageName === PACKAGE_NAME ? REGISTRY_URL : `https://registry.npmjs.org/${packageName}/latest`
  try {
    const response = await fetch(url, {
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
  // The re-exec guard only stops the child re-checking at startup, which is
  // what would loop. A periodic check in the child compares against the
  // child's own (new) version, so it cannot loop and must still run -- or a
  // bridge that updated once would never update again.
  if (options.periodic) return false
  if (process.env[SKIP_UPDATE_ENV] === '1') return true
  if (process.env[LEGACY_SKIP_UPDATE_ENV] === '1') return true
  return false
}

/**
 * Re-run the bridge from the latest published version, inheriting the terminal so the user
 * keeps watching the same window. Passes through the original CLI args and marks the child
 * so it does not re-check at startup.
 *
 * npx runs through the node already running us, not `npx.cmd` off PATH: the launcher and
 * the sign-in entry run node by absolute path, and PATH there often has no npx at all.
 *
 * @returns {{ handedOff: boolean, status: number | null }}
 */
export function runLatestBridge(argv = []) {
  let command
  try {
    command = nodeToolCommand('npx', ['-y', `${PACKAGE_NAME}@latest`, ...argv])
  } catch {
    return { handedOff: false, status: null }
  }
  const result = spawnSync(command.command, command.args, {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, [SKIP_UPDATE_ENV]: '1' },
  })
  return { handedOff: result.error == null && result.status !== null, status: result.status }
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
 *   ask?: (question: string) => Promise<boolean>, noUpdate?: boolean, periodic?: boolean,
 *   beforeHandOff?: () => Promise<void> }} params
 *   `beforeHandOff` releases what the new copy needs (the ports) before it starts.
 * @returns {Promise<{ handedOff: boolean, status: number | null }>} On a handoff the child
 *   has already run to completion; the caller should exit with `status`.
 */
export async function maybeUpdateBridge(params) {
  const { currentVersion, argv = [], log = console.log, ask, noUpdate, periodic, beforeHandOff } = params
  const none = { handedOff: false, status: null }
  if (shouldSkipUpdateCheck({ noUpdate, periodic })) return none

  const latest = await fetchLatestPublishedVersion()
  if (!latest || compareVersions(latest, currentVersion) <= 0) return none

  const autoUpdate = isAutoUpdateEnabled()

  if (!autoUpdate) {
    log('')
    log(`A newer ${DISPLAY_NAME} is available: ${currentVersion} → ${latest}.`)
    // Auto-update is off, so never update silently — ask if we can, otherwise just notify.
    const accepted = ask && process.stdin.isTTY ? await ask('Update now?') : false
    if (!accepted) {
      log(`Update anytime with: npx ${PACKAGE_NAME}@latest`)
      log(`(Re-enable automatic updates with: npx ${PACKAGE_NAME} --auto-update)`)
      return none
    }
  } else {
    log('')
    log(`Updating ${DISPLAY_NAME} ${currentVersion} → ${latest} (automatic updates are on)…`)
    log(`Turn this off anytime with: npx ${PACKAGE_NAME} --no-auto-update`)
  }

  await beforeHandOff?.()
  const result = runLatestBridge(argv)
  if (!result.handedOff) {
    log('Automatic update failed to launch. Run this manually to update:')
    log(`  npx ${PACKAGE_NAME}@latest`)
  }
  return result
}
