import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { normalizeAdbExecError, requireAdbExecutable } from '../adb/adb-resolve.mjs'
import {
  buildEmulatorPullPaths,
  KNOWN_EMULATOR_ADB_HOSTS,
} from './device-paths.mjs'
import { bytesLookLikeSaveFile } from './save-bytes.mjs'
import { resolveDeviceDisplayName } from '../adb/device-label.mjs'
import {
  discoverNativeHostSave,
  formatNativeHostPullResult,
} from './native-save-discovery.mjs'
import {
  isTransientUsbAdbError,
  resolveUsbPullRetries,
  waitForStableAdbDevice,
  waitForUsbStackSettle,
} from '../adb/usb-settle.mjs'

const execFileAsync = promisify(execFile)
const ROOT_RESTART_DELAY_MS = 1_500
/** Dead emulator ports should fail fast instead of blocking each pull for ~15s. */
const ADB_CONNECT_TIMEOUT_MS = 2_500
const ADB_PATH_PROBE_TIMEOUT_MS = 5_000
const ADB_FIND_SAVE_TIMEOUT_MS = 12_000
const ADB_ROOT_TIMEOUT_MS = 8_000

export class BridgeNoDeviceError extends Error {
  code = 'no-device'

  constructor(message) {
    super(message)
    this.name = 'BridgeNoDeviceError'
  }
}

export class BridgeSaveNotFoundError extends Error {
  code = 'save-not-found'

  constructor(message, deviceSerial) {
    super(message)
    this.name = 'BridgeSaveNotFoundError'
    this.deviceSerial = deviceSerial
  }
}

function adbArgs(serial, args) {
  return serial ? ['-s', serial, ...args] : args
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runAdb(serial, args, timeoutMs = 120_000) {
  const adb = await requireAdbExecutable()
  try {
    const { stdout, stderr } = await execFileAsync(adb, adbArgs(serial, args), {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    return `${stdout || ''}${stderr || ''}`.trim()
  } catch (error) {
    throw normalizeAdbExecError(error)
  }
}

async function runAdbBinary(serial, args, timeoutMs = 120_000) {
  const adb = await requireAdbExecutable()
  try {
    const { stdout } = await execFileAsync(adb, adbArgs(serial, args), {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'buffer',
    })
    return stdout
  } catch (error) {
    throw normalizeAdbExecError(error)
  }
}

/** @param {string | undefined} customPort */
export function buildKnownHosts(customPort) {
  const hosts = []
  const port = String(customPort ?? '').trim()
  if (/^\d{4,5}$/.test(port)) {
    hosts.push(`127.0.0.1:${port}`)
  }
  for (const host of KNOWN_EMULATOR_ADB_HOSTS) {
    if (!hosts.includes(host)) {
      hosts.push(host)
    }
  }
  return hosts
}

/** True for TCP emulators (127.0.0.1:port) and the Android Emulator serial form. */
export function isEmulatorAdbSerial(serial) {
  const trimmed = String(serial ?? '').trim()
  return /^127\.0\.0\.1:\d+$/.test(trimmed) || /^emulator-\d+$/.test(trimmed)
}

export function orderSerialsForPullAttempts(serials, hostPriority) {
  const ordered = []
  const seen = new Set()
  for (const host of hostPriority) {
    if (serials.includes(host) && !seen.has(host)) {
      ordered.push(host)
      seen.add(host)
    }
  }
  for (const serial of serials) {
    if (!seen.has(serial)) {
      ordered.push(serial)
      seen.add(serial)
    }
  }
  return ordered
}

/** USB phones/tablets first; emulators only if no physical device is online. */
export function orderSerialsPreferPhysical(serials, hostPriority) {
  const physical = []
  const emulators = []
  for (const serial of serials) {
    if (isEmulatorAdbSerial(serial)) {
      emulators.push(serial)
    } else {
      physical.push(serial)
    }
  }
  return [...physical, ...orderSerialsForPullAttempts(emulators, hostPriority)]
}

async function ensureAdbServer() {
  try {
    await runAdb(null, ['start-server'], 20_000)
  } catch {
    // Server may already be running.
  }
}

async function readAdbDevicesListing() {
  return runAdb(null, ['devices'], 15_000)
}

async function listDeviceSerials() {
  const listing = await readAdbDevicesListing()
  const serials = []
  for (const line of listing.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('List of devices')) continue
    const [serial, state] = trimmed.split(/\s+/)
    if (serial && state === 'device') {
      serials.push(serial)
    }
  }
  return serials
}

async function connectHost(host) {
  try {
    await runAdb(null, ['connect', host], ADB_CONNECT_TIMEOUT_MS)
    await delay(150)
    return (await getDeviceState(host)) === 'device'
  } catch {
    return false
  }
}

async function connectKnownHostsParallel(hosts) {
  if (!hosts.length) return
  await Promise.all(hosts.map(host => connectHost(host)))
}

/**
 * Legacy detectEmulator(): probe each known host with connect + get-state, then adb devices.
 * @param {string | undefined} customPort
 */
export async function resolveOnlineEmulatorTargets(customPort) {
  const hostPriority = buildKnownHosts(customPort)
  await ensureAdbServer()

  const targets = []
  const seen = new Set()

  const add = serial => {
    if (!serial || seen.has(serial)) return
    seen.add(serial)
    targets.push(serial)
  }

  for (const serial of await listDeviceSerials()) {
    add(serial)
  }

  const customPortTrimmed = String(customPort ?? '').trim()
  const needsHostProbe = targets.length === 0 || /^\d{4,5}$/.test(customPortTrimmed)

  if (needsHostProbe) {
    const hostsToProbe = /^\d{4,5}$/.test(customPortTrimmed)
      ? hostPriority.slice(0, 1)
      : hostPriority
    await connectKnownHostsParallel(hostsToProbe)
    for (const serial of await listDeviceSerials()) {
      add(serial)
    }
  }

  return orderSerialsForPullAttempts(await dedupeSameDevice(targets), hostPriority)
}

/**
 * Wait for ANDROID, not just for adbd.
 *
 * ADB reports a device as `device` the moment adbd starts, which is well before the system is up.
 * In that window `adb shell` works but app data directories are not populated, so a pull finds
 * nothing and reports "no save found" -- indistinguishable, to the user, from the game not being
 * installed. MuMu states it directly: `MuMuManager.exe info -v 0` returns
 * `"is_android_started": false, "player_state": "starting_rom"` while its ADB port already accepts
 * connections.
 *
 * @param {string} serial
 * @param {{ timeoutMs?: number, onProgress?: (message: string) => void }} [options]
 * @returns {Promise<boolean>} true once booted, false if the timeout ran out.
 */
async function waitForAndroidBoot(serial, { timeoutMs = 90_000, onProgress } = {}) {
  const started = Date.now()
  let announced = false
  while (Date.now() - started < timeoutMs) {
    let booted = false
    try {
      const out = await runAdb(serial, ['shell', 'getprop', 'sys.boot_completed'], 5_000)
      booted = String(out).trim().startsWith('1')
    } catch {
      booted = false
    }
    if (booted) {
      // The boot animation can still be running with boot_completed already set; app data is
      // reliably in place once it stops. Best-effort only -- some builds never report it.
      try {
        const anim = await runAdb(serial, ['shell', 'getprop', 'init.svc.bootanim'], 5_000)
        if (String(anim).trim() === 'running') {
          await delay(1_000)
          continue
        }
      } catch { /* property unavailable: boot_completed is enough */ }
      if (announced) onProgress?.('Emulator finished booting')
      return true
    }
    if (!announced) {
      announced = true
      onProgress?.('Emulator is still booting — waiting for Android to come up')
    }
    await delay(1_500)
  }
  return false
}

/**
 * The SAME emulator commonly appears twice -- once as 127.0.0.1:port and once as emulator-NNNN.
 * Measured on MuMu: both entries report product:dm1q model:SM_S9110, one device wearing two names.
 * Trying both wastes a full pull attempt (path probes, timeouts) on a device already known to have
 * failed, which is time the user spends watching nothing happen.
 *
 * @param {string[]} serials
 * @returns {Promise<string[]>}
 */
async function dedupeSameDevice(serials) {
  if (serials.length < 2) return serials
  const kept = []
  const seenFingerprints = new Map()
  for (const serial of serials) {
    // FINGERPRINT ON boot_id, NOT ro.serialno. The first version of this used `getprop ro.serialno`,
    // which is EMPTY on this emulator -- so the dedupe silently matched nothing and was dead code
    // that looked correct. /proc/sys/kernel/random/boot_id is set per running kernel, so two serials
    // reaching the same booted system report the same value (measured: both 127.0.0.1:16384 and
    // emulator-5554 return 3f640297..., while ro.serialno returns nothing for either).
    let fingerprint = null
    for (const probe of [
      ['shell', 'cat', '/proc/sys/kernel/random/boot_id'],
      ['shell', 'getprop', 'ro.serialno'],
    ]) {
      try {
        const raw = String(await runAdb(serial, probe, 5_000)).trim()
        if (raw) { fingerprint = raw; break }
      } catch { /* try the next probe */ }
    }
    if (fingerprint && seenFingerprints.has(fingerprint)) continue
    if (fingerprint) seenFingerprints.set(fingerprint, serial)
    kept.push(serial)
  }
  return kept
}

async function getDeviceState(serial) {
  try {
    return await runAdb(serial, ['get-state'], 8_000)
  } catch {
    return ''
  }
}

/** @deprecated Kept for tests — production uses orderSerialsForPullAttempts + multi-device pull. */
export function pickPreferredDeviceSerial(serials, hostPriority = KNOWN_EMULATOR_ADB_HOSTS) {
  const ordered = orderSerialsForPullAttempts(serials, hostPriority)
  return ordered[0] ?? null
}

async function remotePathExists(serial, remotePath) {
  try {
    const out = await runAdb(
      serial,
      ['shell', 'test', '-f', remotePath, '&&', 'echo', 'ok'],
      ADB_PATH_PROBE_TIMEOUT_MS,
    )
    return /\bok\b/i.test(out)
  } catch {
    return false
  }
}

async function tryAdbRoot(serial) {
  try {
    const out = await runAdb(serial, ['root'], ADB_ROOT_TIMEOUT_MS)
    const rooted =
      /already running as root/i.test(out) || /restarting adbd as root/i.test(out)
    if (rooted && /restarting adbd/i.test(out)) {
      await delay(ROOT_RESTART_DELAY_MS)
    }
    return rooted
  } catch {
    return false
  }
}

async function pullRemotePath(serial, remotePath) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adb-bridge-'))
  const localPath = path.join(tmpDir, 'pulled-save.bin')
  try {
    await runAdb(serial, ['pull', remotePath, localPath], 120_000)
    const bytes = await fs.readFile(localPath)
    if (bytes.byteLength <= 0) {
      throw new Error('Pulled save file is empty.')
    }
    return bytes
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function readViaShellCat(serial, remotePath) {
  try {
    const bytes = await runAdbBinary(serial, ['exec-out', 'cat', remotePath], 60_000)
    if (bytes?.byteLength > 0 && bytesLookLikeSaveFile(bytes)) {
      return bytes
    }
  } catch {
    // cat requires root or world-readable paths
  }
  return null
}

async function tryPullPath(serial, remotePath) {
  if (!(await remotePathExists(serial, remotePath))) {
    return null
  }
  try {
    const bytes = await pullRemotePath(serial, remotePath)
    if (bytesLookLikeSaveFile(bytes)) {
      return { remotePath, bytes }
    }
  } catch {
    // fall through to cat
  }
  const bytes = await readViaShellCat(serial, remotePath)
  if (bytes) {
    return { remotePath, bytes }
  }
  return null
}

/** Every filename worth trying for this game, primary first. */
function saveFilenamesFor(profile) {
  return [profile.saveFilename, ...profile.alternateSaveFilenames]
}

/**
 * Single-quote a value for the device's `sh`. Save filenames come from a
 * profile, which a user can write, so they reach a shell as data and must not
 * be able to end the quoting and run something else.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

async function findSavePaths(serial, profile, { includeDataData = false } = {}) {
  const roots = includeDataData
    ? ['/data/data', '/sdcard', '/storage/emulated/0']
    : ['/sdcard', '/storage/emulated/0']
  // -iname is case-insensitive, so one term covers every spelling variant of a
  // given name; genuinely different names (a save and its backup) need their own.
  const nameExpr = saveFilenamesFor(profile)
    .map(name => `-iname ${shellQuote(name)}`)
    .join(' -o ')
  try {
    const out = await runAdb(
      serial,
      [
        'shell',
        `find ${roots.join(' ')} -maxdepth 8 \\( ${nameExpr} \\) 2>/dev/null | head -n 6`,
      ],
      ADB_FIND_SAVE_TIMEOUT_MS,
    )
    return out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}

const STAGING_TMP_PATH = '/data/local/tmp/adb_bridge_save.tmp'

/** USB phones must not treat Download/Downloads exports as the game save. */
export function isPhysicalAppSavePath(remotePath) {
  const normalized = String(remotePath ?? '').trim()
  if (!normalized) return false
  const lower = normalized.toLowerCase()
  if (/\/download(s)?\//.test(lower)) return false
  if (
    normalized.startsWith('run-as:')
    || normalized.startsWith('staging-tmp:')
    || normalized.startsWith('native:')
  ) {
    return true
  }
  if (/\/android\/data\/[^/]+\/files\//i.test(normalized)) return true
  if (/\/data\/data\/[^/]+\/files\//i.test(normalized)) return true
  return false
}

/**
 * The profile's package ids, plus anything installed that looks like the same
 * game -- regional builds and betas ship under slightly different ids.
 */
async function discoverInstalledPackages(serial, profile) {
  const packages = new Set(profile.androidPackages)
  // Match on the distinctive segments of the known ids (publisher, title)
  // rather than a hard-coded pattern, so this works for any game.
  const hints = new Set()
  for (const pkg of profile.androidPackages) {
    for (const segment of pkg.split('.').slice(1)) {
      if (segment.length >= 4) hints.add(segment.toLowerCase())
    }
  }
  try {
    const listing = await runAdb(serial, ['shell', 'pm', 'list', 'packages'], 45_000)
    for (const line of listing.split(/\r?\n/)) {
      const match = line.match(/^package:(.+)$/i)
      if (!match) continue
      const pkg = match[1].trim()
      const lower = pkg.toLowerCase()
      if ([...hints].some(hint => lower.includes(hint))) {
        packages.add(pkg)
      }
    }
  } catch {
    // pm list failed — use known package ids only
  }
  return [...packages]
}

function buildOfficialAppSavePaths(packages, profile) {
  const paths = []
  for (const pkg of packages) {
    for (const root of ['/storage/emulated/0', '/sdcard', '/mnt/sdcard']) {
      for (const filename of saveFilenamesFor(profile)) {
        paths.push(`${root}/Android/data/${pkg}/files/${filename}`)
      }
    }
  }
  return paths
}

async function pullViaRunAs(serial, packages, profile) {
  const relPaths = saveFilenamesFor(profile).map(name => `files/${name}`)
  for (const pkg of packages) {
    for (const rel of relPaths) {
      try {
        const bytes = await runAdbBinary(
          serial,
          ['exec-out', 'run-as', pkg, 'cat', rel],
          60_000,
        )
        if (bytes?.byteLength > 0 && bytesLookLikeSaveFile(bytes)) {
          return {
            remotePath: `run-as:${pkg}/${rel}`,
            bytes,
          }
        }
      } catch {
        continue
      }
    }
  }
  return null
}

async function pullViaRunAsShell(serial, packages, profile) {
  // One shell round trip that falls through every candidate name, instead of
  // one adb invocation per name.
  const catChain = saveFilenamesFor(profile)
    .map(name => `cat ${shellQuote('files/' + name)} 2>/dev/null`)
    .join(' || ')
  for (const pkg of packages) {
    try {
      const bytes = await runAdbBinary(
        serial,
        [
          'exec-out',
          'run-as',
          pkg,
          'sh',
          '-c',
          catChain,
        ],
        60_000,
      )
      if (bytes?.byteLength > 0 && bytesLookLikeSaveFile(bytes)) {
        return {
          remotePath: `run-as:${pkg}/sh-cat`,
          bytes,
        }
      }
    } catch {
      continue
    }
  }
  return null
}

async function pullViaRunAsStaging(serial, packages, profile) {
  const copyChain = saveFilenamesFor(profile)
    .map(name => `cp ${shellQuote('files/' + name)} ${shellQuote(STAGING_TMP_PATH)} 2>/dev/null`)
    .join(' || ')
  for (const pkg of packages) {
    try {
      await runAdb(
        serial,
        [
          'shell',
          'run-as',
          pkg,
          'sh',
          '-c',
          copyChain,
        ],
        30_000,
      )
      const bytes = await readViaShellCat(serial, STAGING_TMP_PATH)
      await runAdb(serial, ['shell', 'rm', '-f', STAGING_TMP_PATH], 10_000).catch(() => {})
      if (bytes) {
        return {
          remotePath: `staging-tmp:${pkg}`,
          bytes,
        }
      }
    } catch {
      continue
    }
  }
  return null
}

async function pullViaRunAsAll(serial, packages, profile) {
  return (
    (await pullViaRunAsShell(serial, packages, profile))
    ?? (await pullViaRunAs(serial, packages, profile))
    ?? (await pullViaRunAsStaging(serial, packages, profile))
  )
}

export function pickLargestSaveCandidate(candidates) {
  if (!candidates?.length) return null
  return candidates.reduce((best, current) =>
    current.bytes.byteLength > best.bytes.byteLength ? current : best,
  )
}

/** Phone saves live in app storage; Downloads often has a stale small copy. */
async function discoverAndPullPhysical(serial, profile) {
  const candidates = []
  const rejectedDownloadOnly = []
  const packages = await discoverInstalledPackages(serial, profile)

  const tryCollect = async puller => {
    const pulled = await puller()
    if (!pulled) return
    if (isPhysicalAppSavePath(pulled.remotePath)) {
      candidates.push(pulled)
      return
    }
    rejectedDownloadOnly.push(pulled)
  }

  await tryCollect(() => pullViaRunAsAll(serial, packages, profile))

  const officialPaths = buildOfficialAppSavePaths(packages, profile)
  for (const remotePath of officialPaths) {
    await tryCollect(() => tryPullPath(serial, remotePath))
  }

  const rooted = await tryAdbRoot(serial)
  if (rooted) {
    for (const pkg of packages) {
      for (const filename of saveFilenamesFor(profile)) {
        await tryCollect(() => tryPullPath(serial, `/data/data/${pkg}/files/${filename}`))
      }
    }
  }

  const discovered = await findSavePaths(serial, profile, { includeDataData: rooted })
  const sortedDiscovered = [...discovered]
    .filter(remotePath => isPhysicalAppSavePath(remotePath))
    .sort((a, b) => {
      const score = path =>
        (/\/android\/data\//i.test(path) ? 4 : 0) + (/\/data\/data\//i.test(path) ? 8 : 0)
      return score(b) - score(a)
    })
  for (const remotePath of sortedDiscovered) {
    await tryCollect(() => tryPullPath(serial, remotePath))
  }

  const best = pickLargestSaveCandidate(candidates)
  if (best) return best

  if (rejectedDownloadOnly.length > 0) {
    throw new BridgeSaveNotFoundError(
      `Found a ${profile.name} save in Download/Downloads but could not read the real save from app storage. `
      + `On Android 11+ /Android/data is not readable over USB without developer access. `
      + `Open ${profile.name}, save your progress, then retry.`,
      serial,
    )
  }

  return null
}

async function discoverAndPullEmulator(serial, profile) {
  const pullPaths = buildEmulatorPullPaths(profile)

  for (const remotePath of pullPaths) {
    const pulled = await tryPullPath(serial, remotePath)
    if (pulled) return pulled
  }

  const packages = await discoverInstalledPackages(serial, profile)
  const runAsPull = await pullViaRunAsAll(serial, packages, profile)
  if (runAsPull) return runAsPull

  const rooted = await tryAdbRoot(serial)
  if (rooted) {
    for (const pkg of packages) {
      for (const filename of saveFilenamesFor(profile)) {
        const internal = await tryPullPath(serial, `/data/data/${pkg}/files/${filename}`)
        if (internal) return internal
      }
    }
  }

  for (const candidate of await findSavePaths(serial, profile, { includeDataData: rooted })) {
    const pulled = await tryPullPath(serial, candidate)
    if (pulled) return pulled
  }

  return null
}

async function discoverAndPull(serial, profile, options = {}) {
  if (options.preferPhysicalDevice) {
    return discoverAndPullPhysical(serial, profile)
  }
  return discoverAndPullEmulator(serial, profile)
}

async function tryPullOnSerial(serial, profile, options = {}) {
  const pulled = await discoverAndPull(serial, profile, options)
  if (!pulled) return null
  return {
    remotePath: pulled.remotePath,
    deviceSerial: serial,
    base64: pulled.bytes.toString('base64'),
    byteLength: pulled.bytes.byteLength,
  }
}

async function tryPullOnSerialWithRetries(serial, profile, options = {}) {
  const preferPhysical = Boolean(options.preferPhysicalDevice)
  const maxAttempts = preferPhysical ? resolveUsbPullRetries() : 1
  const consoleUi = options.console

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (preferPhysical && attempt > 1) {
      consoleUi?.log(
        `Connecting to ${serial} via system adb (attempt ${attempt}/${maxAttempts})`,
        0.35 + (attempt - 1) * 0.08,
      )
      await waitForStableAdbDevice(serial, getDeviceState, msg => consoleUi?.log(msg))
    }

    try {
      consoleUi?.log(`Pulling ${profile.saveFilename} from app storage…`, 0.55)
      const result = await tryPullOnSerial(serial, profile, options)
      if (result) {
        consoleUi?.log(
          `File extracted (${result.byteLength} bytes from ${result.remotePath})`,
          0.8,
        )
        return result
      }
    } catch (error) {
      if (!preferPhysical || !isTransientUsbAdbError(error) || attempt >= maxAttempts) {
        throw error
      }
      consoleUi?.log('Device dropped — waiting for USB to settle before retry…', 0.45)
      await waitForUsbStackSettle('retry', msg => consoleUi?.log(msg))
    }
  }

  return null
}

/**
 * Legacy daemon flow: connect known emulator ports, use any online device, pull from
 * each path until one succeeds (same as desktop `adb.pullSave` loop).
 */
export async function pullSave(profile, options = {}) {
  if (!profile) throw new TypeError('pullSave requires a game profile')
  const preferPhysical = Boolean(options.preferPhysicalDevice)
  const preferNativeHost = Boolean(options.preferNativeHost)
  const consoleUi = options.console

  consoleUi?.log('Sync request received from website', 0.05)

  if (preferNativeHost) {
    consoleUi?.log('Scanning native macOS / Windows / Linux game install…', 0.2)
    const nativeOnly = await discoverNativeHostSave(profile)
    if (nativeOnly) {
      consoleUi?.log(`Found save on disk (${nativeOnly.source})`, 0.9)
      consoleUi?.log('Sync complete — port released cleanly', 1)
      return formatNativeHostPullResult(nativeOnly)
    }
    throw new BridgeSaveNotFoundError(
      `Save file not found on this computer. Open ${profile.name} (native or store install), save your progress, then try again.`,
      'native-host',
    )
  }

  consoleUi?.log('Connecting via system adb (host platform-tools)', 0.12)

  if (preferPhysical) {
    consoleUi?.log('Preparing USB — blocking Windows Autoplay reconnect noise', 0.18)
    await waitForUsbStackSettle('before', msg => consoleUi?.log(msg))
  }

  let candidates = await resolveOnlineEmulatorTargets(options.customPort)
  if (preferPhysical) {
    candidates = candidates.filter(serial => !isEmulatorAdbSerial(serial))
  }

  if (!preferPhysical && candidates.length === 0) {
    consoleUi?.log('Checking native macOS / Windows / Linux game install…', 0.2)
    const nativeEarly = await discoverNativeHostSave(profile)
    if (nativeEarly) {
      consoleUi?.log(`Found save on disk (${nativeEarly.source})`, 0.85)
      consoleUi?.log('Sync complete — port released cleanly', 1)
      return formatNativeHostPullResult(nativeEarly)
    }
  }

  let lastTried = null

  for (const serial of candidates) {
    lastTried = serial
    // WAIT FOR THE SYSTEM, NOT JUST FOR adbd. Without this the pull runs against a half-booted
    // emulator, finds no save, and reports "no save found" for a device that is simply not ready.
    if (isEmulatorAdbSerial(serial)) {
      const booted = await waitForAndroidBoot(serial, {
        onProgress: msg => consoleUi?.log(msg, 0.25),
      })
      if (!booted) {
        consoleUi?.log('Emulator did not report a completed boot — trying the pull anyway', 0.3)
      }
    }
    const result = await tryPullOnSerialWithRetries(serial, profile, options)
    if (result) {
      const deviceLabel = await resolveDeviceDisplayName(result.deviceSerial)
      if (preferPhysical) {
        consoleUi?.log('Letting USB connection settle safely…', 0.9)
        await waitForUsbStackSettle('after', msg => consoleUi?.log(msg))
      }
      consoleUi?.log('Sync complete — port released cleanly', 1)
      return { ...result, deviceLabel }
    }
  }

  if (!lastTried) {
    let devicesHint = ''
    try {
      devicesHint = await readAdbDevicesListing()
    } catch {
      devicesHint = '(adb devices failed)'
    }
    const unauthorized = /unauthorized/i.test(devicesHint)
    const offline = /\boffline\b/i.test(devicesHint)
    if (preferPhysical) {
      const usbMessage = unauthorized
        ? 'Your phone is connected but not authorized for USB debugging. Unplug the cable, revoke USB debugging authorizations in Developer options if needed, replug, and tap Allow on the phone when prompted.'
        : offline
          ? 'Your phone is connected but ADB shows it as offline. Try another USB cable or port, set USB mode to File Transfer, then unplug and replug.'
          : 'No authorized USB device detected. Plug in your phone with a data cable, enable USB debugging, allow the debugging prompt on the phone, and confirm adb devices lists it as "device".'
      throw new BridgeNoDeviceError(`${usbMessage}\n\nadb devices:\n${devicesHint}`)
    }
    throw new BridgeNoDeviceError(
      `No supported emulator detected. Start your emulator, enable ADB debugging, then try again.\n\nadb devices:\n${devicesHint}`,
    )
  }

  if (!preferPhysical) {
    consoleUi?.log('ADB scan missed — checking native macOS / Windows / Linux install…', 0.75)
    const nativeFallback = await discoverNativeHostSave(profile)
    if (nativeFallback) {
      consoleUi?.log(`Found save on disk (${nativeFallback.source})`, 0.9)
      consoleUi?.log('Sync complete — port released cleanly', 1)
      return formatNativeHostPullResult(nativeFallback)
    }
  }

  const physicalHint = preferPhysical
    ? ' The bridge only reads from the game app folder (Android/data/…), not Download/Downloads.'
    : ` On Mac/Linux you can also install ${profile.name} natively, or connect an emulator/phone with USB debugging.`
  throw new BridgeSaveNotFoundError(
    `Save file '${profile.saveFilename}' not found via ADB scan.${physicalHint} Open ${profile.name}, save your progress, then try again.`,
    lastTried,
  )
}
