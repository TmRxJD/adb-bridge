#!/usr/bin/env node
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { findWindowsAdbInstallDir } from './ensure-user-path.mjs'
import { installPlatformTools } from './adb/platform-tools-install.mjs'

const execFileAsync = promisify(execFile)

await installPlatformTools(message => {
  console.log(message)
})

const adbDir = findWindowsAdbInstallDir()
if (adbDir) {
  const adbExe = path.join(adbDir, 'adb.exe')
  try {
    const { stdout } = await execFileAsync(adbExe, ['version'], { timeout: 15_000, windowsHide: true })
    console.log(stdout.trim())
  } catch (error) {
    console.warn(
      `adb is installed at ${adbDir} but could not run it here. Open a new PowerShell window and run: adb devices`,
    )
    if (error instanceof Error) console.warn(error.message)
  }
}
