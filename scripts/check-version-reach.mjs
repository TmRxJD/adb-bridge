#!/usr/bin/env node
/**
 * Will an existing install actually receive this release?
 *
 * The shims depend on adb-bridge by range. Under npm's rules a `^0.2.1` range
 * accepts 0.2.x but *not* 0.3.0, because a minor bump below 1.0.0 is treated as
 * breaking. So publishing adb-bridge 0.3.0 while a shim asks for `^0.2.1`
 * silently strands every shim user on the version they already have -- which,
 * for the release that fixes a bridge users cannot use, would mean shipping the
 * fix to nobody.
 *
 * That is not something to remember at publish time, so it runs in
 * prepublishOnly. Fails with the specific version to publish instead.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))

const root = readJson(path.join(ROOT, 'package.json'))
const [major, minor] = root.version.split(/[.-]/).map(Number)

/** Highest version a caret range admits, per npm's 0.x rule. */
function caretAdmits(range, version) {
  const spec = range.replace(/^[\^~]/, '')
  const [sMajor, sMinor, sPatch] = spec.split('.').map(Number)
  const [vMajor, vMinor, vPatch] = version.split(/[.-]/).map(Number)
  if (vMajor !== sMajor) return false
  // Below 1.0.0 a caret pins the minor; at or above it, the minor may float.
  if (sMajor === 0 && vMinor !== sMinor) return false
  if (vMinor < sMinor) return false
  if (vMinor === sMinor && vPatch < sPatch) return false
  return true
}

const problems = []
const shimsDir = path.join(ROOT, 'shims')
let shims = []
try {
  shims = readdirSync(shimsDir, { withFileTypes: true }).filter(entry => entry.isDirectory())
} catch {
  shims = []
}

for (const shim of shims) {
  const manifestPath = path.join(shimsDir, shim.name, 'package.json')
  let manifest
  try { manifest = readJson(manifestPath) } catch { continue }
  const range = manifest.dependencies?.['adb-bridge']
  if (!range) continue
  if (!caretAdmits(range, root.version)) {
    problems.push({ shim: manifest.name, range, suggestion: `0.${minor}.${Number(root.version.split('.')[2]) || 0}` })
  }
}

console.log(`adb-bridge ${root.version}; checked ${shims.length} shim(s)`)

if (problems.length === 0) {
  console.log('every shim range reaches this release')
  process.exit(0)
}

console.error('\nThese shims will NOT receive this release:\n')
for (const problem of problems) {
  console.error(`  ${problem.shim} depends on adb-bridge@${problem.range}`)
  console.error(`      ${root.version} falls outside that range, so installs keep their current copy.`)
  console.error(`      Publish a ${major}.${minor}.x patch instead, or widen the shim range and republish it.`)
}
process.exit(1)
