#!/usr/bin/env node
/**
 * Build the Windows installer (AdbBridgeSetup.exe) with Inno Setup.
 *
 * Usage:  node installer/windows/build.mjs [--copy-to <dir>]
 *
 * Requires the Inno Setup 6 compiler:
 *   winget install -e --id JRSoftware.InnoSetup
 *
 * The version comes from package.json, so the installer and the npm package
 * cannot drift apart.
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..', '..')
const { version } = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))

const ISCC_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env['ProgramFiles(x86)'] ?? '', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.ProgramFiles ?? '', 'Inno Setup 6', 'ISCC.exe'),
]

function findIscc() {
  const found = ISCC_CANDIDATES.find(candidate => candidate && existsSync(candidate))
  if (found) return found
  console.error('Inno Setup compiler (ISCC.exe) not found. Install it with:')
  console.error('  winget install -e --id JRSoftware.InnoSetup')
  process.exit(1)
}

const iscc = findIscc()
console.log(`Building ADB Bridge installer ${version}`)
execFileSync(iscc, [`/DMyAppVersion=${version}`, 'adb-bridge.iss'], {
  cwd: here,
  stdio: 'inherit',
})

const output = path.join(pkgRoot, 'dist', 'AdbBridgeSetup.exe')
if (!existsSync(output)) {
  console.error(`Expected installer at ${output} but it was not produced.`)
  process.exit(1)
}
console.log(`\nBuilt: ${output}`)

const copyIndex = process.argv.indexOf('--copy-to')
if (copyIndex !== -1 && process.argv[copyIndex + 1]) {
  const destDir = path.resolve(process.argv[copyIndex + 1])
  mkdirSync(destDir, { recursive: true })
  const dest = path.join(destDir, 'AdbBridgeSetup.exe')
  copyFileSync(output, dest)
  console.log(`Copied to: ${dest}`)
}
