import path from 'node:path'
import {
  AdbNotFoundError,
  clearCachedAdbPath,
  findInstalledAdbOffPath,
  resolveAdbExecutable,
  setCachedAdbPath,
} from './adb-resolve.mjs'
import { persistUserPathEntry, prependProcessPath } from './adb-path.mjs'
import { installPlatformTools } from './platform-tools-install.mjs'

export async function registerAdbOnPath(adbExecutable, log = console.log) {
  const dirPath = path.dirname(adbExecutable)
  const addedToSession = prependProcessPath(dirPath)
  if (addedToSession) {
    log(`Added platform-tools to this session PATH: ${dirPath}`)
  }

  try {
    const persisted = await persistUserPathEntry(dirPath)
    if (persisted.changed) {
      log('Added platform-tools to your user PATH. Open a new terminal to use adb everywhere.')
    }
  } catch (error) {
    log(
      `Could not update user PATH automatically (${error instanceof Error ? error.message : error}). `
      + `The bridge will still use: ${adbExecutable}`,
    )
  }

  setCachedAdbPath(adbExecutable)
  return adbExecutable
}

export async function ensureAdbReady(log = console.log) {
  if (process.env.LOCAL_ADB_BRIDGE_SKIP_AUTO_INSTALL === '1') {
    const adb = await resolveAdbExecutable()
    if (!adb) {
      throw new AdbNotFoundError()
    }
    return adb
  }

  let adb = await resolveAdbExecutable()
  if (adb) {
    log(`Using adb: ${adb}`)
    return adb
  }

  const offPath = findInstalledAdbOffPath()
  if (offPath) {
    log(`Found adb installed off PATH: ${offPath}`)
    return registerAdbOnPath(offPath, log)
  }

  log('Android platform-tools (adb) not found. Installing automatically...')
  clearCachedAdbPath()
  await installPlatformTools(log)
  clearCachedAdbPath()

  adb = await resolveAdbExecutable()
  if (adb) {
    log(`Installed platform-tools at: ${adb}`)
    return registerAdbOnPath(adb, log)
  }

  const afterInstall = findInstalledAdbOffPath()
  if (afterInstall) {
    log(`Located adb after install: ${afterInstall}`)
    return registerAdbOnPath(afterInstall, log)
  }

  throw new AdbNotFoundError(
    'Platform-tools install finished, but adb still could not be found. Restart the bridge terminal or set ADB_PATH manually.',
  )
}
