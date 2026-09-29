import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { adbBinaryName, fileExists } from './adb-path.mjs'
import { bundledAdbPath, installPlatformTools } from './platform-tools-install.mjs'

const execFileAsync = promisify(execFile)

/**
 * The one place the bridge gets an adb binary from. It finds one, proves it
 * runs, and installs one itself if there is none -- every adb call goes through
 * `requireAdbExecutable`, so any pull or status check self-heals.
 *
 * Why this file got rewritten: an `ensureAdbReady` that could install adb
 * existed, but nothing in the running bridge ever called it. Pulls went through
 * a lookup-only function and failed with "The bridge attempted automatic setup
 * but could not finish" -- a message describing setup that never ran, telling
 * the user to `npx tracker-bridge`, a package renamed away twice. Users were
 * sent to install platform-tools by hand and then fight PATH.
 *
 * PATH is deliberately not part of this. The bridge runs adb by absolute path,
 * so whether adb is on the user's PATH has no effect on it. The old flow
 * edited the user PATH through PowerShell after every install, and each of
 * those edits was a way for a working install to be reported as a failure.
 */

let cachedAdbPath = null
let healing = null

export function clearCachedAdbPath() {
  cachedAdbPath = null
}

function commonAdbCandidates() {
  const home = os.homedir()
  const localAppData = process.env.LOCALAPPDATA
  const bin = adbBinaryName()
  // Our own copy first: it is the one the bridge installed and knows works.
  const candidates = [bundledAdbPath()]

  if (process.platform === 'win32') {
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Android', 'Sdk', 'platform-tools', bin))
      candidates.push(path.join(localAppData, 'Microsoft', 'WinGet', 'Links', bin))
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
    for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/PlatformTools|platform-tools/i.test(entry.name)) continue
      const base = path.join(packagesRoot, entry.name)
      out.push(path.join(base, 'platform-tools', bin))
      out.push(path.join(base, bin))
    }
  } catch {
    // No winget packages directory: nothing installed that way.
  }
  return out
}

async function adbOnPath() {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(lookup, [adbBinaryName()], {
      timeout: 5_000,
      windowsHide: true,
    })
    return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * A file named adb is not proof of a usable adb. A winget link left behind by
 * an uninstall, an SDK copy missing its DLLs, or a binary for the wrong
 * architecture all exist and all fail -- and a lookup that stopped at the first
 * existing file would pick that one forever and never try the next.
 */
async function adbRuns(adbPath) {
  try {
    const { stdout } = await execFileAsync(adbPath, ['version'], {
      timeout: 15_000,
      windowsHide: true,
    })
    return /Android Debug Bridge/i.test(stdout)
  } catch {
    return false
  }
}

async function orderedCandidates() {
  const fromEnv = process.env.ADB_PATH || process.env.LOCAL_ADB_BRIDGE_ADB
  const all = [
    ...(fromEnv ? [fromEnv] : []),
    ...(await adbOnPath()),
    ...commonAdbCandidates(),
    ...winGetPackageAdbCandidates(),
  ]
  const seen = new Set()
  return all.filter(candidate => {
    const key = path.normalize(candidate).toLowerCase()
    if (seen.has(key) || !fileExists(candidate)) return false
    seen.add(key)
    return true
  })
}

/** Finds a working adb without installing anything. */
export async function resolveAdbExecutable() {
  if (cachedAdbPath && fileExists(cachedAdbPath)) {
    return cachedAdbPath
  }
  cachedAdbPath = null
  for (const candidate of await orderedCandidates()) {
    if (await adbRuns(candidate)) {
      cachedAdbPath = candidate
      return candidate
    }
  }
  return null
}

export function adbNotFoundMessage(detail) {
  const reason = detail ? ` (${detail})` : ''
  return (
    `The bridge could not download Android platform-tools (adb)${reason}. `
    + 'Check your internet connection and try again -- the bridge retries the install on every request. '
    + 'If you already have adb somewhere, set ADB_PATH to it.'
  )
}

export class AdbNotFoundError extends Error {
  /** @type {'adb-not-found'} */
  code = 'adb-not-found'

  constructor(message = adbNotFoundMessage()) {
    super(message)
    this.name = 'AdbNotFoundError'
  }
}

/**
 * Returns a working adb, installing platform-tools first if none exists.
 *
 * Concurrent callers share one install: the site checks status and pulls at
 * nearly the same moment, and two downloads extracting into the same folder
 * would corrupt each other.
 */
export async function requireAdbExecutable(log = console.log) {
  const found = await resolveAdbExecutable()
  if (found) return found

  if (process.env.LOCAL_ADB_BRIDGE_SKIP_AUTO_INSTALL === '1') {
    throw new AdbNotFoundError(
      'adb was not found and automatic install is disabled (LOCAL_ADB_BRIDGE_SKIP_AUTO_INSTALL=1).',
    )
  }

  healing ??= (async () => {
    log('adb not found -- installing Android platform-tools automatically...')
    try {
      await installPlatformTools(log)
    } catch (error) {
      throw new AdbNotFoundError(adbNotFoundMessage(error instanceof Error ? error.message : String(error)))
    }
    clearCachedAdbPath()
    const installed = await resolveAdbExecutable()
    if (!installed) {
      throw new AdbNotFoundError(adbNotFoundMessage('it installed, but the adb it installed does not run'))
    }
    log(`adb ready: ${installed}`)
    return installed
  })().finally(() => {
    // A failed attempt must not stick: the next request tries again, which is
    // what makes "fix your connection and try again" true.
    healing = null
  })
  return healing
}

/** Whether adb is on the user's PATH -- informational only; the bridge never needs it. */
export async function adbIsOnPath() {
  return (await adbOnPath()).length > 0
}

function isEnoent(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

export function normalizeAdbExecError(error) {
  if (error instanceof AdbNotFoundError) {
    return error
  }
  if (isEnoent(error) || /spawn .*adb.* enoent/i.test(error instanceof Error ? error.message : String(error))) {
    // The cached binary vanished (uninstalled mid-session). Drop it so the
    // next call re-resolves, and reinstalls if nothing else is left.
    clearCachedAdbPath()
    return new AdbNotFoundError('adb disappeared while the bridge was running. Try again -- the bridge will reinstall it.')
  }
  return error
}
