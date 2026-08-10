import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const pathEntrySep = process.platform === 'win32' ? ';' : ':'

export function fileExists(filePath) {
  try {
    return fs.existsSync(filePath)
  } catch {
    return false
  }
}

export function adbBinaryName() {
  return process.platform === 'win32' ? 'adb.exe' : 'adb'
}

export function pathEntries(value) {
  return value.split(pathEntrySep).map(entry => entry.trim()).filter(Boolean)
}

export function isDirectoryOnPath(dirPath, pathValue = process.env.PATH ?? '') {
  const normalized = path.normalize(dirPath)
  return pathEntries(pathValue).some(entry => path.normalize(entry) === normalized)
}

export function prependProcessPath(dirPath) {
  const normalized = path.normalize(dirPath)
  if (isDirectoryOnPath(normalized)) {
    return false
  }
  process.env.PATH = `${normalized}${pathEntrySep}${process.env.PATH ?? ''}`
  return true
}

export function readUserPath() {
  if (process.platform === 'win32') {
    return process.env.Path ?? process.env.PATH ?? ''
  }
  return process.env.PATH ?? ''
}

export async function persistUserPathEntry(dirPath) {
  const normalized = path.normalize(dirPath)
  if (isDirectoryOnPath(normalized, readUserPath())) {
    return { changed: false, scope: 'user' }
  }

  if (process.platform === 'win32') {
    return persistWindowsUserPath(normalized)
  }
  if (process.platform === 'darwin') {
    return persistUnixShellPath(normalized, ['.zprofile', '.zshrc', '.bash_profile', '.bashrc'])
  }
  return persistUnixShellPath(normalized, ['.profile', '.bashrc'])
}

async function persistWindowsUserPath(dirPath) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const escaped = dirPath.replace(/'/g, "''")
  const script = `
$dir = '${escaped}'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ([string]::IsNullOrWhiteSpace($userPath)) { $userPath = '' }
if ($userPath.Split(';') -notcontains $dir) {
  [Environment]::SetEnvironmentVariable('Path', ($dir + ';' + $userPath).TrimEnd(';'), 'User')
}
`.trim()

  await execFileAsync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 30_000, windowsHide: true },
  )
  return { changed: true, scope: 'user' }
}

async function persistUnixShellPath(dirPath, profileNames) {
  const home = os.homedir()
  const exportLine = `export PATH="${dirPath}:$PATH" # Added by local-adb-bridge`
  const marker = '# Added by local-adb-bridge'

  for (const profileName of profileNames) {
    const profilePath = path.join(home, profileName)
    if (!fileExists(profilePath)) continue
    const contents = fs.readFileSync(profilePath, 'utf8')
    if (contents.includes(marker) && contents.includes(dirPath)) {
      return { changed: false, scope: 'user' }
    }
    if (!contents.includes(marker)) {
      fs.appendFileSync(profilePath, `\n${exportLine}\n`, 'utf8')
      return { changed: true, scope: 'user' }
    }
  }

  const fallback = path.join(home, '.profile')
  if (!fileExists(fallback)) {
    fs.writeFileSync(fallback, `${exportLine}\n`, 'utf8')
    return { changed: true, scope: 'user' }
  }
  fs.appendFileSync(fallback, `\n${exportLine}\n`, 'utf8')
  return { changed: true, scope: 'user' }
}
