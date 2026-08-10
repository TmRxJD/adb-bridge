import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { requireAdbExecutable } from './adb-resolve.mjs'

const execFileAsync = promisify(execFile)

function isEmulatorSerial(serial) {
  const trimmed = String(serial ?? '').trim()
  return /^127\.0\.0\.1:\d+$/.test(trimmed) || /^emulator-\d+$/.test(trimmed)
}

function titleCaseWord(word) {
  if (!word) return ''
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

/** @param {string} manufacturer @param {string} productName */
export function formatDeviceDisplayName(manufacturer, productName) {
  const name = String(productName ?? '').trim()
  if (!name || /^unknown$/i.test(name) || /^sdk_/i.test(name)) {
    return ''
  }
  const mfr = String(manufacturer ?? '').trim()
  if (!mfr || /^unknown$/i.test(mfr)) {
    return name
  }
  const mfrTitle = titleCaseWord(mfr)
  if (name.toLowerCase().includes(mfr.toLowerCase())) {
    return name
  }
  return `${mfrTitle} ${name}`
}

async function getProp(serial, key) {
  const adb = await requireAdbExecutable()
  const args = ['-s', serial, 'shell', 'getprop', key]
  const { stdout } = await execFileAsync(adb, args, {
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 256 * 1024,
  })
  return String(stdout ?? '').trim()
}

/**
 * Human-readable phone/tablet name (e.g. "Samsung Galaxy S23") for a USB adb serial.
 * @param {string | undefined} serial
 * @returns {Promise<string | null>}
 */
export async function resolveDeviceDisplayName(serial) {
  const trimmed = String(serial ?? '').trim()
  if (!trimmed || isEmulatorSerial(trimmed)) {
    return null
  }

  try {
    const [marketName, model, manufacturer, brand] = await Promise.all([
      getProp(trimmed, 'ro.product.marketname'),
      getProp(trimmed, 'ro.product.model'),
      getProp(trimmed, 'ro.product.manufacturer'),
      getProp(trimmed, 'ro.product.brand'),
    ])

    const fromMarket = formatDeviceDisplayName(manufacturer || brand, marketName)
    if (fromMarket) return fromMarket

    const fromModel = formatDeviceDisplayName(manufacturer || brand, model)
    if (fromModel) return fromModel

    return null
  } catch {
    return null
  }
}
