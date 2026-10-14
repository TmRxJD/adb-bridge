import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire, isBuiltin, registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

// Process-local dependency injection: package files and installed dependencies stay untouched.
const { values } = parseArgs({ options: {
  'dependencies-root': { type: 'string' },
  'sdk-root': { type: 'string' },
  'platform-root': { type: 'string' },
  'expect-sdk-version': { type: 'string' },
  'expect-platform-version': { type: 'string' },
} })
assert.ok(values['dependencies-root'], '--dependencies-root is required')
assert.equal(Boolean(values['sdk-root']), Boolean(values['platform-root']), 'Provide both prepared package roots, or neither for registry validation')
const dependencyRequire = createRequire(pathToFileURL(path.resolve(values['dependencies-root'], 'package.json')))
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readPackage = root => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const localPackages = new Map([['adb-bridge', { root: repo, manifest: readPackage(repo) }]])

function packageFromEntry(name, entry) {
  let dir = path.dirname(entry)
  for (let depth = 0; depth < 12; depth++) {
    const manifestPath = path.join(dir, 'package.json')
    if (fs.existsSync(manifestPath)) {
      const manifest = readPackage(dir)
      if (manifest.name === name) return { root: dir, manifest }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  assert.fail('No matching manifest within 12 ancestors of ' + name + ' entry: ' + entry)
}

// Resolve installed package manifests from public entries, not unexported package.json paths.
const installedPlatformEntry = values['platform-root'] ? null : dependencyRequire.resolve('@tmrxjd/platform/node')
const installedPlatform = installedPlatformEntry ? packageFromEntry('@tmrxjd/platform', installedPlatformEntry) : null
const platformRequire = installedPlatformEntry ? createRequire(pathToFileURL(installedPlatformEntry)) : null
for (const [name, option] of [['@tmrxjd/platform', 'platform-root'], ['thetowersdk', 'sdk-root']]) {
  const installed = values[option] ? null : name === '@tmrxjd/platform'
    ? installedPlatform : packageFromEntry(name, platformRequire.resolve('thetowersdk/node'))
  const root = values[option] ? path.resolve(values[option]) : installed.root
  const manifest = readPackage(root)
  assert.equal(manifest.name, name)
  assert.ok(fs.existsSync(path.join(root, 'dist/node/index.js')), name + ' build is not ready')
  localPackages.set(name, { root, manifest })
}

// Capture shared dependencies before registration so their resolution cannot recurse into the hook.
const dependencyUrls = new Map(['zod', '@tmrxjd/tracker-languages', 'appwrite'].map(name =>
  [name, pathToFileURL(dependencyRequire.resolve(name)).href],
))
let resolvingDependency = false
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (resolvingDependency) return nextResolve(specifier, context)
    if (dependencyUrls.has(specifier)) return { url: dependencyUrls.get(specifier), shortCircuit: true }
    for (const [name, { root, manifest }] of localPackages) {
      if (specifier !== name && !specifier.startsWith(name + '/')) continue
      const key = specifier === name ? '.' : './' + specifier.slice(name.length + 1)
      const entry = manifest.exports?.[key]
      const target = typeof entry === 'string' ? entry : entry?.require ?? entry?.default
      assert.ok(target, 'Missing package export: ' + specifier)
      return { url: pathToFileURL(path.join(root, target)).href, shortCircuit: true }
    }
    if (!isBuiltin(specifier) && !specifier.startsWith('.') && !path.isAbsolute(specifier) && !specifier.startsWith('file:')) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND') throw error
      }
      try {
        resolvingDependency = true
        const url = pathToFileURL(dependencyRequire.resolve(specifier)).href
        dependencyUrls.set(specifier, url)
        return { url, shortCircuit: true }
      } finally {
        resolvingDependency = false
      }
    }
    return nextResolve(specifier, context)
  },
})

try {
  const { extractBattleRunsFromSave } = await import('../plugins/uploader-thetower/run-upload.mjs')
  const bytes = Buffer.from(JSON.stringify({
    VersionNumber: 2910, ResearchLevel: [7, 12], UpgradeWorkshopLevel: [42, 18],
    BattleHistory: [{ Tier: 8, Wave: 1234, CoinsEarned: 1e10, BattleDate: '2026-10-13T12:00:00Z' }],
  }))
  const runs = extractBattleRunsFromSave(bytes)
  assert.equal(runs.length, 1, 'The real uploader must extract the official JSON battle')
  assert.equal(runs[0].tier, 8)
  assert.equal(runs[0].wave, 1234)
  assert.equal(runs[0].coinsEarned, 1e10)
  console.log('PASS: actual uploader extracts one official JSON battle (tier 8, wave 1234, coins 10000000000)')
  for (const name of ['@tmrxjd/platform', 'thetowersdk']) {
    const { root, manifest } = localPackages.get(name)
    const expected = values[name === 'thetowersdk' ? 'expect-sdk-version' : 'expect-platform-version']
    if (expected) assert.equal(manifest.version, expected, name + ' release version differs')
    console.log(name + '@' + manifest.version + (values['sdk-root'] ? ' (prepared build)' : ' (registry install)') + ' ' + root)
  }
} finally {
  hooks.deregister()
}
