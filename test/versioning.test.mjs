import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { BRIDGE_PRODUCT, BRIDGE_PROTOCOL_VERSION, BRIDGE_VERSION } from '../src/game-bridge.mjs'
import { compareVersions } from '../src/update-check.mjs'

const require_ = createRequire(import.meta.url)
const manifest = require_('../package.json')

/**
 * The rename from tracker-bridge to adb-bridge broke users twice, both times
 * because a package identity was written down somewhere instead of derived:
 *
 *  - the website gated on `version >= 1.4.0`, and the version had reset to 0.x
 *  - the updater fetched `tracker-bridge/latest` and compared it to our own
 *    version, so it always looked outdated and "updated" to the shim
 *
 * These check the identities still line up with the manifest, so a future
 * rename cannot quietly reintroduce either.
 */

test('the reported version is the published version', () => {
  assert.equal(BRIDGE_VERSION, manifest.version)
})

test('the update check targets this package, not a hardcoded former name', async () => {
  const source = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../src/update-check.mjs', import.meta.url), 'utf8',
  ))
  assert.ok(
    !/registry\.npmjs\.org\/tracker-bridge/.test(source),
    'update-check must not fetch the old package name',
  )
  assert.ok(
    source.includes('manifest.name'),
    'the package name must come from package.json so a rename cannot desync it',
  )
})

test('the protocol version is what compatibility hangs on, and is stable', () => {
  // Deliberately pinned. If this ever needs to change, the website's
  // LOCAL_ADB_BRIDGE_MIN_PROTOCOL has to change with it, in that order.
  assert.equal(BRIDGE_PROTOCOL_VERSION, 1)
  assert.equal(typeof BRIDGE_PROTOCOL_VERSION, 'number')
})

test('the product name is reported so clients can tell bridges apart', () => {
  assert.equal(BRIDGE_PRODUCT, manifest.name)
})

test('a release number going backwards does not imply being out of date', () => {
  // The exact comparison that failed: adb-bridge 0.2.1 against tracker-bridge
  // 1.8.1. Version order is a fine question; it is just not the same question
  // as "can this bridge talk to the site".
  assert.ok(compareVersions('1.8.1', '0.2.1') > 0)
  assert.equal(compareVersions('0.2.1', '0.2.1'), 0)
})
