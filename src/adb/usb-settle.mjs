function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Milliseconds to wait so Windows Autoplay/MTP can finish before/after adb I/O. */
export function resolveUsbSettleMs() {
  const raw = process.env.LOCAL_ADB_BRIDGE_USB_SETTLE_MS
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  if (Number.isFinite(parsed) && parsed >= 0) return parsed
  return process.platform === 'win32' ? 800 : 200
}

export function resolveUsbPullRetries() {
  const raw = process.env.LOCAL_ADB_BRIDGE_USB_PULL_RETRIES
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 6) return parsed
  return 3
}

/** @param {unknown} error */
export function isTransientUsbAdbError(error) {
  const haystack = `${error instanceof Error ? error.message : error}`.toLowerCase()
  return (
    /\boffline\b/.test(haystack)
    || /unauthorized/.test(haystack)
    || /device not found/.test(haystack)
    || /no devices/.test(haystack)
    || /closed/.test(haystack)
    || /disconnect/.test(haystack)
    || /cannot connect/.test(haystack)
    || /error:\s*device/.test(haystack)
    || /didn't ack/.test(haystack)
    || /failed to get feature/.test(haystack)
  )
}

/**
 * Pause on Windows while the USB composite stack switches away from MTP/Autoplay.
 * @param {'before' | 'after' | 'retry'} phase
 * @param {(message: string) => void} [log]
 */
export async function waitForUsbStackSettle(phase, log) {
  const ms = resolveUsbSettleMs()
  if (ms <= 0 || process.platform !== 'win32') return
  const detail =
    phase === 'before'
      ? 'before opening the device'
      : phase === 'after'
        ? 'after the save transfer'
        : 'before retry'
  log?.(`USB stack settling (${detail}, ${ms}ms)`)
  await delay(ms)
}

/**
 * Require consecutive `device` states so adb is not mid-reconnect (Autoplay glitch).
 * @param {string} serial
 * @param {(serial: string) => Promise<string>} getState
 * @param {(message: string) => void} [log]
 */
export async function waitForStableAdbDevice(serial, getState, log) {
  const requiredStreak = 3
  const intervalMs = 350
  const maxWaitMs = 14_000
  const started = Date.now()
  let streak = 0

  while (Date.now() - started < maxWaitMs) {
    const state = (await getState(serial)).trim()
    if (state === 'device') {
      streak += 1
      if (streak >= requiredStreak) {
        log?.(`Device ${serial} stable on adb`)
        return true
      }
    } else {
      streak = 0
    }
    await delay(intervalMs)
  }

  return (await getState(serial)).trim() === 'device'
}
