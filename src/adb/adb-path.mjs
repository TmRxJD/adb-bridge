import fs from 'node:fs'

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
