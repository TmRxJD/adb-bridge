import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileExists } from './adb/adb-path.mjs'

const execFileAsync = promisify(execFile)

/** Directories where winget / SDK installs commonly place adb.exe on Windows. */
export function windowsAdbInstallDirCandidates() {
  const localAppData = process.env.LOCALAPPDATA || ''
  const userProfile = process.env.USERPROFILE || ''
  const dirs = [
    path.join(localAppData, 'Android', 'Sdk', 'platform-tools'),
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
    path.join(userProfile, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools'),
    'C:\\Android\\platform-tools',
    'C:\\platform-tools',
  ]

  if (localAppData) {
    const packagesRoot = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages')
    try {
      for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/PlatformTools|platform-tools/i.test(entry.name)) continue
        const base = path.join(packagesRoot, entry.name)
        dirs.push(path.join(base, 'platform-tools'))
        dirs.push(base)
      }
    } catch {
      void 0
    }
  }

  const seen = new Set()
  return dirs.filter(dir => {
    const key = path.normalize(dir).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function findWindowsAdbInstallDir() {
  for (const dir of windowsAdbInstallDirCandidates()) {
    if (fileExists(path.join(dir, 'adb.exe'))) {
      return dir
    }
  }
  return null
}

/**
 * Append a directory to the Windows user PATH and the current process PATH.
 */
export async function appendWindowsUserPath(dir, log = () => {}) {
  if (process.platform !== 'win32') return
  const normalized = path.normalize(dir)
  const escaped = normalized.replace(/'/g, "''")
  const script = `
$dir = '${escaped}'
if (-not (Test-Path (Join-Path $dir 'adb.exe'))) { throw "adb.exe not found in $dir" }
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ([string]::IsNullOrWhiteSpace($userPath)) { $userPath = '' }
if ($userPath -notlike "*$dir*") {
  $joined = if ($userPath) { "$userPath;$dir" } else { $dir }
  [Environment]::SetEnvironmentVariable('Path', $joined, 'User')
}
if ($env:Path -notlike "*$dir*") { $env:Path = if ($env:Path) { "$env:Path;$dir" } else { $dir } }
Write-Output "Added to user PATH: $dir"
`
  await execFileAsync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 30_000, windowsHide: true },
  )
  log(`Added platform-tools to user PATH: ${normalized}`)
}

export async function ensureWindowsAdbOnUserPath(log = () => {}) {
  const dir = findWindowsAdbInstallDir()
  if (!dir) {
    throw new Error(
      'adb.exe was not found after install. Expected it under %LOCALAPPDATA%\\Android\\Sdk\\platform-tools or WinGet Links.',
    )
  }
  await appendWindowsUserPath(dir, log)
  return dir
}
