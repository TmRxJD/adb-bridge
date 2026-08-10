import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileExists } from './adb-path.mjs'
import { appendWindowsUserPath, ensureWindowsAdbOnUserPath, findWindowsAdbInstallDir } from '../ensure-user-path.mjs'

const execFileAsync = promisify(execFile)

const PLATFORM_TOOLS_BASE = 'https://dl.google.com/android/repository'
const DOWNLOAD_URLS = {
  win32: `${PLATFORM_TOOLS_BASE}/platform-tools-latest-windows.zip`,
  darwin: `${PLATFORM_TOOLS_BASE}/platform-tools-latest-darwin.zip`,
  linux: `${PLATFORM_TOOLS_BASE}/platform-tools-latest-linux.zip`,
}

export function bundledPlatformToolsRoot() {
  return path.join(os.homedir(), '.local-adb-bridge', 'platform-tools')
}

export function bundledAdbPath() {
  const root = bundledPlatformToolsRoot()
  return path.join(root, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
}

async function commandExists(command) {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('where', [command], { timeout: 5_000, windowsHide: true })
    } else {
      await execFileAsync('which', [command], { timeout: 5_000 })
    }
    return true
  } catch {
    return false
  }
}

async function runCommand(command, args, options = {}) {
  const { timeout = 300_000, inheritStdio = false } = options
  if (inheritStdio) {
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'inherit', shell: false })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`Timed out running ${command}`))
      }, timeout)
      child.on('error', reject)
      child.on('close', code => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`${command} exited with code ${code}`))
      })
    })
    return
  }

  await execFileAsync(command, args, {
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
}

async function wingetPlatformToolsInstalled() {
  try {
    const { stdout } = await execFileAsync(
      'winget',
      ['list', '--id', 'Google.PlatformTools', '--accept-source-agreements'],
      { timeout: 60_000, windowsHide: true },
    )
    return /Google\.PlatformTools/i.test(stdout)
  } catch {
    return false
  }
}

async function installWithWinget(log, { force = false } = {}) {
  const installed = await wingetPlatformToolsInstalled()
  if (!installed || force) {
    const args = [
      'install',
      '-e',
      '--id',
      'Google.PlatformTools',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity',
    ]
    if (force) {
      args.push('--force')
    }
    log(
      force
        ? 'Repairing Android Platform Tools with winget...'
        : 'Installing Android Platform Tools with winget...',
    )
    await runCommand('winget', args, { timeout: 600_000 })
  } else {
    log('Android Platform Tools already installed via winget. Ensuring adb is on your PATH...')
  }
  await ensureWindowsAdbOnUserPath(log)
}

async function installWithBrew(log) {
  log('Installing Android Platform Tools with Homebrew...')
  if (await commandExists('adb')) {
    return
  }
  const listed = await commandExists('brew')
    ? await execFileAsync('brew', ['list', 'android-platform-tools'], { timeout: 60_000 }).then(() => true).catch(() => false)
    : false
  if (listed) {
    log('Reinstalling android-platform-tools with Homebrew...')
    await runCommand('brew', ['reinstall', 'android-platform-tools'], { timeout: 600_000, inheritStdio: true })
    return
  }
  await runCommand('brew', ['install', 'android-platform-tools'], { timeout: 600_000, inheritStdio: true })
}

async function installWithApt(log) {
  if (!(await commandExists('apt-get'))) {
    throw new Error('apt-get is not available on this system.')
  }
  log('Installing android-tools-adb with apt (sudo may prompt for your password)...')
  await runCommand('sudo', ['apt-get', 'update'], { timeout: 300_000, inheritStdio: true })
  await runCommand('sudo', ['apt-get', 'install', '-y', 'android-tools-adb'], {
    timeout: 600_000,
    inheritStdio: true,
  })
}

async function downloadFile(url, destination) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download platform-tools (${response.status}).`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  await fs.promises.mkdir(path.dirname(destination), { recursive: true })
  await fs.promises.writeFile(destination, bytes)
}

async function extractZip(zipPath, destination) {
  await fs.promises.mkdir(destination, { recursive: true })
  if (process.platform === 'win32') {
    const escapedZip = zipPath.replace(/'/g, "''")
    const escapedDest = destination.replace(/'/g, "''")
    await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${escapedDest}' -Force`,
      ],
      { timeout: 300_000, windowsHide: true },
    )
    return
  }

  await runCommand('unzip', ['-o', zipPath, '-d', destination], { timeout: 300_000 })
}

export async function installPlatformToolsZip(log) {
  const platformKey =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const url = DOWNLOAD_URLS[platformKey]
  const root = bundledPlatformToolsRoot()
  const zipPath = path.join(root, 'download', 'platform-tools.zip')

  log('Downloading Android Platform Tools from Google...')
  await downloadFile(url, zipPath)
  log('Extracting platform-tools...')
  await fs.promises.rm(path.join(root, 'platform-tools'), { recursive: true, force: true }).catch(() => {})
  await extractZip(zipPath, root)
  await fs.promises.rm(path.dirname(zipPath), { recursive: true, force: true }).catch(() => {})

  if (!fileExists(bundledAdbPath())) {
    throw new Error('Downloaded platform-tools, but adb was not found in the extracted folder.')
  }
  if (process.platform === 'win32') {
    const bundledDir = path.dirname(bundledAdbPath())
    await appendWindowsUserPath(bundledDir, log)
  }
  return bundledAdbPath()
}

export async function installPlatformTools(log = console.log) {
  if (process.env.LOCAL_ADB_BRIDGE_SKIP_AUTO_INSTALL === '1') {
    throw new Error('Automatic platform-tools install is disabled (LOCAL_ADB_BRIDGE_SKIP_AUTO_INSTALL=1).')
  }

  if (process.platform === 'win32') {
    const existingDir = findWindowsAdbInstallDir()
    if (existingDir && fileExists(path.join(existingDir, 'adb.exe'))) {
      await appendWindowsUserPath(existingDir, log)
      log('Open a new PowerShell window for adb to be recognized, or run: adb devices')
      return
    }
    if (await commandExists('winget')) {
      try {
        await installWithWinget(log)
        return
      } catch (error) {
        log(`winget install failed (${error instanceof Error ? error.message : error}). Trying direct download...`)
      }
    }
  }

  if (process.platform === 'darwin' && (await commandExists('brew'))) {
    try {
      await installWithBrew(log)
      return
    } catch (error) {
      log(`Homebrew install failed (${error instanceof Error ? error.message : error}). Trying direct download...`)
    }
  }

  if (process.platform === 'linux' && (await commandExists('apt-get'))) {
    try {
      await installWithApt(log)
      return
    } catch (error) {
      log(`apt install failed (${error instanceof Error ? error.message : error}). Trying direct download...`)
    }
  }

  await installPlatformToolsZip(log)
}
