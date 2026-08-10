import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

/**
 * Each test gets its own ADB_BRIDGE_HOME. The module reads the env var through
 * configDir() on every call, so pointing it somewhere fresh is enough -- no
 * mocking, and nothing touches the real ~/.adb-bridge.
 */
async function withTempHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-bridge-test-'))
  const previous = process.env.ADB_BRIDGE_HOME
  process.env.ADB_BRIDGE_HOME = home
  try {
    // Cache-bust so each case gets a module bound to this home.
    const state = await import(`../src/bridge-state.mjs?t=${encodeURIComponent(home)}`)
    await run(state, home)
  } finally {
    if (previous === undefined) delete process.env.ADB_BRIDGE_HOME
    else process.env.ADB_BRIDGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
}

test('a fresh machine reports no configured bridge', async () => {
  await withTempHome(state => {
    assert.equal(state.bridgeIsConfigured(), false)
    assert.deepEqual(state.readEnabledGameIds(), [])
  })
})

test('enabling a game is what makes an existing bridge serve it', async () => {
  await withTempHome(state => {
    assert.deepEqual(state.enableGame('thetower'), ['thetower'])
    // The whole point: a second game joins the same bridge.
    assert.deepEqual(state.enableGame('cifi'), ['thetower', 'cifi'])
    assert.equal(state.bridgeIsConfigured(), true)
    assert.equal(state.isGameEnabled('cifi'), true)
  })
})

test('enabling twice does not duplicate', async () => {
  await withTempHome(state => {
    state.enableGame('cifi')
    assert.deepEqual(state.enableGame('cifi'), ['cifi'])
  })
})

test('disabling leaves the other games alone', async () => {
  await withTempHome(state => {
    state.enableGame('thetower')
    state.enableGame('cifi')
    assert.deepEqual(state.disableGame('thetower'), ['cifi'])
    assert.equal(state.isGameEnabled('thetower'), false)
  })
})

test('disabling something that was never enabled is not an error', async () => {
  await withTempHome(state => {
    assert.deepEqual(state.disableGame('nothing'), [])
  })
})

test('a corrupt state file reads as empty rather than throwing', async () => {
  await withTempHome((state, home) => {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'bridge.json'), '{ this is not json')
    // Must not crash the daemon on start.
    assert.deepEqual(state.readEnabledGameIds(), [])
    // ...and must still be recoverable.
    assert.deepEqual(state.enableGame('cifi'), ['cifi'])
  })
})

test('state survives a rewrite (write-then-rename leaves no truncated file)', async () => {
  await withTempHome((state, home) => {
    state.enableGame('thetower')
    state.enableGame('cifi')
    const written = JSON.parse(fs.readFileSync(path.join(home, 'bridge.json'), 'utf8'))
    assert.deepEqual(written.games, ['thetower', 'cifi'])
    assert.equal(fs.existsSync(path.join(home, 'bridge.json.tmp')), false)
  })
})
