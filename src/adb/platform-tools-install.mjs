import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileExists } from './adb-path.mjs'

const execFileAsync = promisify(execFile)

const PLATFORM_TOOLS_BASE = 'https://dl.google.com/android/repository'
const DOWNLOAD_URLS = {
  win32: `${PLATFORM_TOOLS_BASE}/platform-tools-latest-windows.zip`,
  darwin: `${PLATFORM_TOOLS_BASE}/platform-tools-latest-darwin.zip`,
  linux: `${PLATFORM_TOOLS_BASE}/platform-tools-latest-linux.zip`,
}

/**
 * Installs Android platform-tools into the bridge's own folder.
 *
 * Google's zip is the primary route, not a last resort, because it is the only
 * one that needs nothing from the user: no admin rights, no sudo password, no
 * package manager, no PATH edit, and no new terminal afterwards. The old order
 * tried winget / Homebrew / apt first. winget "succeeded" while leaving adb
 * somewhere the bridge did not look, apt stopped at a sudo prompt nobody could
 * see when the bridge ran at sign-in, and every route finished by editing PATH
 * -- which the bridge never needed, since it runs adb by absolute path.
 */

export function bundledPlatformToolsRoot() {
  return path.join(os.homedir(), '.local-adb-bridge', 'platform-tools')
}

export function bundledAdbPath() {
  return path.join(bundledPlatformToolsRoot(), 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
}

async function download(url, destination) {
  const response = await fetch(url, { signal: globalThis.AbortSignal.timeout(180_000) })
  if (!response.ok) {
    throw new Error(`download from Google failed with HTTP ${response.status}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  await fs.promises.mkdir(path.dirname(destination), { recursive: true })
  await fs.promises.writeFile(destination, bytes)
}

/**
 * Extraction tools, in the order tried. Each is present by default on its
 * platform, and a second one exists for the machines where the first is not:
 * Windows 10 1803+ ships bsdtar as tar.exe, which reads zips; PowerShell covers
 * older builds. Minimal Linux images often lack unzip but have python3.
 */
function extractors(zipPath, destination) {
  if (process.platform === 'win32') {
    const quote = value => value.replace(/'/g, "''")
    return [
      ['tar', ['-xf', zipPath, '-C', destination]],
      ['powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath '${quote(zipPath)}' -DestinationPath '${quote(destination)}' -Force`,
      ]],
    ]
  }
  return [
    ['unzip', ['-o', '-q', zipPath, '-d', destination]],
    ['python3', ['-m', 'zipfile', '-e', zipPath, destination]],
  ]
}

async function extract(zipPath, destination) {
  const failures = []
  for (const [command, args] of extractors(zipPath, destination)) {
    try {
      await execFileAsync(command, args, { timeout: 300_000, windowsHide: true })
      return
    } catch (error) {
      failures.push(`${command}: ${error instanceof Error ? error.message.split('\n')[0] : error}`)
    }
  }
  throw new Error(`could not unpack the download (${failures.join('; ')})`)
}

export async function installPlatformTools(log = console.log) {
  const platformKey = process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
  const root = bundledPlatformToolsRoot()
  const zipPath = path.join(root, 'download', 'platform-tools.zip')
  // Extract beside the live copy and swap it in, so an interrupted install
  // never leaves a half-unpacked folder where the working adb used to be.
  const staging = path.join(root, 'staging')

  log('Downloading Android platform-tools from Google (about 7 MB)...')
  await download(DOWNLOAD_URLS[platformKey], zipPath)

  log('Unpacking platform-tools...')
  await fs.promises.rm(staging, { recursive: true, force: true })
  await fs.promises.mkdir(staging, { recursive: true })
  try {
    await extract(zipPath, staging)
    const unpacked = path.join(staging, 'platform-tools')
    const adb = path.join(unpacked, process.platform === 'win32' ? 'adb.exe' : 'adb')
    if (!fileExists(adb)) {
      throw new Error('the download did not contain adb')
    }
    // python3's zipfile drops the executable bit that unzip would keep.
    if (process.platform !== 'win32') await fs.promises.chmod(adb, 0o755)

    const live = path.join(root, 'platform-tools')
    await fs.promises.rm(live, { recursive: true, force: true })
    await fs.promises.rename(unpacked, live)
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
    await fs.promises.rm(path.dirname(zipPath), { recursive: true, force: true }).catch(() => {})
  }
  log(`Installed platform-tools to ${path.dirname(bundledAdbPath())}`)
}
