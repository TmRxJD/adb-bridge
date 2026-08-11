#!/usr/bin/env node
/**
 * Will an existing install actually receive this release?
 *
 * The shims depend on adb-bridge by range, and a range that does not admit the
 * version being published means those installs silently keep the copy they
 * already have. For the release that fixes a bridge users cannot use, that
 * would be shipping the fix to nobody.
 *
 * This is not something to remember at publish time, so it runs in
 * prepublishOnly and fails with the specific version to publish instead.
 *
 * Uses `semver` rather than parsing ranges by hand. The first version of this
 * script did parse them by hand, understood only carets, and started reporting
 * every shim as unreachable the moment the ranges were widened to
 * `>=0.2.2 <1.0.0` -- a guard that cries wolf is worse than no guard.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))

const root = readJson(path.join(ROOT, 'package.json'))
const version = root.version

const shimsDir = path.join(ROOT, 'shims')
let shims = []
try {
  shims = readdirSync(shimsDir, { withFileTypes: true }).filter(entry => entry.isDirectory())
} catch {
  shims = []
}

const problems = []
for (const shim of shims) {
  let manifest
  try { manifest = readJson(path.join(shimsDir, shim.name, 'package.json')) } catch { continue }

  const range = manifest.dependencies?.[root.name]
  if (!range) continue

  if (!semver.satisfies(version, range, { includePrerelease: true })) {
    problems.push({ shim: manifest.name, range })
  }
}

console.log(`${root.name} ${version}; checked ${shims.length} shim(s)`)

if (problems.length === 0) {
  console.log('every shim range reaches this release')
  process.exit(0)
}

console.error('\nThese shims will NOT receive this release:\n')
for (const problem of problems) {
  console.error(`  ${problem.shim} depends on ${root.name}@${problem.range}`)
  console.error(`      ${version} does not satisfy that range, so installs keep their current copy.`)
  console.error('      Widen the shim range and republish it, or publish a version the range admits.')
}
process.exit(1)
