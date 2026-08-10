import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { adbBinaryName, fileExists } from './adb-path.mjs'
import { bundledAdbPath } from './platform-tools-install.mjs'

const execFileAsync = promisify(execFile)

let cachedAdbPath = null

export function clearCachedAdbPath() {
  cachedAdbPath = null
}

export function setCachedAdbPath(adbPath) {
  cachedAdbPath = adbPath
}

function commonAdbCandidates() {
  const home = os.homedir()
  const localAppData = process.env.LOCALAPPDATA
  const userProfile = process.env.USERPROFILE
  const bin = adbBinaryName()
  const candidates = []

  if (process.platform === 'win32') {
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Android', 'Sdk', 'platform-tools', bin))
      candidates.push(path.join(localAppData, 'Microsoft', 'WinGet', 'Links', bin))
    }
    if (userProfile) {
      candidates.push(path.join(userProfile, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', bin))
    }
    candidates.push('C:\\Android\\platform-tools\\adb.exe')
    candidates.push('C:\\platform-tools\\adb.exe')
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', bin))
    candidates.push('/opt/homebrew/bin/adb')
    candidates.push('/usr/local/bin/adb')
  } else {
    candidates.push(path.join(home, 'Android', 'Sdk', 'platform-tools', bin))
    candidates.push(path.join(home, 'android-sdk', 'platform-tools', bin))
    candidates.push('/usr/bin/adb')
    candidates.push('/usr/local/bin/adb')
  }

  candidates.push(bundledAdbPath())
  return candidates
}

function winGetPackageAdbCandidates() {
  if (process.platform !== 'win32') return []
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return []

  const packagesRoot = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages')
  const out = []
  const bin = adbBinaryName()

  try {
    const entries = fs.readdirSync(packagesRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !/PlatformTools|platform-tools/i.test(entry.name)) continue
      const base = path.join(packagesRoot, entry.name)
      out.push(path.join(base, 'platform-tools', bin))
      out.push(path.join(base, bin))
    }
  } catch {
    // Unreadable SDK dir — fall through to the next candidate.
  }

  return out
}

export function findInstalledAdbOffPath() {
  const fromEnv = process.env.ADB_PATH || process.env.LOCAL_ADB_BRIDGE_ADB
  if (fromEnv && fileExists(fromEnv)) {
    return fromEnv
  }

  const seen = new Set()
  for (const candidate of [...commonAdbCandidates(), ...winGetPackageAdbCandidates()]) {
    const normalized = path.normalize(candidate)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    if (fileExists(normalized)) {
      return normalized
    }
  }

  return null
}

async function findOnPath() {
  const bin = adbBinaryName()
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('where', [bin], {
        timeout: 5_000,
        windowsHide: true,
      })
      const first = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(Boolean)
      if (first && fileExists(first)) {
        return first
      }
    } catch {
      // Directory vanished or is not listable; try the next one.
    }
    return null
  }

  try {
    const { stdout } = await execFileAsync('which', [bin], { timeout: 5_000 })
    const resolved = stdout.trim().split(/\r?\n/)[0]
    if (resolved && fileExists(resolved)) {
      return resolved
    }
  } catch {
    // No adb on PATH — the caller falls back to the bundled resolver.
  }
  return null
}

export function adbInstallHint() {
  if (process.platform === 'win32') {
    return 'winget install Google.PlatformTools'
  }
  if (process.platform === 'darwin') {
    return 'brew install android-platform-tools'
  }
  return 'sudo apt install android-tools-adb'
}

export function adbNotOnPathMessage(adbPath) {
  const folder = adbPath ? ` (${adbPath})` : ''
  return (
    `ADB is installed${folder} but is not on your PATH. `
    + 'Add platform-tools to your user PATH, open a new terminal, then run adb devices.'
  )
}

export function adbNotFoundMessage() {
  return (
    'ADB is not installed. The bridge attempted automatic setup but could not finish. '
    + `Try: ${adbInstallHint()} — or set ADB_PATH before running npx tracker-bridge.`
  )
}

/** @returns {'none' | 'not-installed' | 'not-on-path'} */
export async function probeAdbPathIssue() {
  const onPath = await findOnPath()
  if (onPath) {
    return { issue: 'none', onPath: true, adbPath: onPath }
  }
  const offPath = findInstalledAdbOffPath()
  if (offPath) {
    return { issue: 'not-on-path', onPath: false, adbPath: offPath }
  }
  return { issue: 'not-installed', onPath: false, adbPath: null }
}

export class AdbNotFoundError extends Error {
  /** @type {'adb-not-found'} */
  code = 'adb-not-found'

  constructor(message = adbNotFoundMessage()) {
    super(message)
    this.name = 'AdbNotFoundError'
  }
}

export class AdbNotOnPathError extends Error {
  /** @type {'adb-not-on-path'} */
  code = 'adb-not-on-path'

  /** @param {string} [adbPath] */
  constructor(adbPath) {
    super(adbNotOnPathMessage(adbPath))
    this.name = 'AdbNotOnPathError'
    this.adbPath = adbPath
  }
}

function isEnoent(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

export async function resolveAdbExecutable() {
  if (cachedAdbPath && fileExists(cachedAdbPath)) {
    return cachedAdbPath
  }

  const fromEnv = process.env.ADB_PATH || process.env.LOCAL_ADB_BRIDGE_ADB
  if (fromEnv && fileExists(fromEnv)) {
    cachedAdbPath = fromEnv
    return cachedAdbPath
  }

  const onPath = await findOnPath()
  if (onPath) {
    cachedAdbPath = onPath
    return cachedAdbPath
  }

  const offPath = findInstalledAdbOffPath()
  if (offPath) {
    cachedAdbPath = offPath
    return cachedAdbPath
  }

  return null
}

export async function requireAdbExecutable() {
  const adb = await resolveAdbExecutable()
  if (!adb) {
    throw new AdbNotFoundError()
  }
  return adb
}

export function normalizeAdbExecError(error) {
  if (error instanceof AdbNotFoundError) {
    return error
  }
  if (isEnoent(error)) {
    return new AdbNotFoundError()
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/spawn adb enoent/i.test(message) || /enoent.*\badb\b/i.test(message)) {
    return new AdbNotFoundError()
  }
  return error
}
