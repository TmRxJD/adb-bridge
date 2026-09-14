import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ensurePluginCurrent } from '../src/upload/plugin-install.mjs'
import { compareVersions } from '../src/update-check.mjs'

/**
 * An installed plugin used to stay at whatever version was first installed, so
 * fixes to uploading never reached existing users. With automatic updates on,
 * the bridge now updates its own copy before loading it.
 */
function withPlugin(version, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-bridge-update-'))
  const previous = process.env.ADB_BRIDGE_HOME
  process.env.ADB_BRIDGE_HOME = home
  const dir = path.join(home, 'plugins', 'node_modules', 'adb-bridge-uploader-fixture')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'adb-bridge-uploader-fixture', version }))
  return run().finally(() => {
    if (previous === undefined) delete process.env.ADB_BRIDGE_HOME
    else process.env.ADB_BRIDGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })
}

function deps(overrides = {}) {
  const installs = []
  return {
    installs,
    value: {
      fetchLatest: async () => '0.2.1',
      compareVersions,
      isAutoUpdateEnabled: () => true,
      install: async name => {
        installs.push(name)
      },
      ...overrides,
    },
  }
}

test('an outdated plugin is updated when automatic updates are on', () =>
  withPlugin('0.2.0', async () => {
    const d = deps()
    assert.equal(await ensurePluginCurrent('adb-bridge-uploader-fixture', () => {}, d.value), 'updated')
    assert.deepEqual(d.installs, ['adb-bridge-uploader-fixture'])
  }))

test('a current plugin is left alone', () =>
  withPlugin('0.2.1', async () => {
    const d = deps()
    assert.equal(await ensurePluginCurrent('adb-bridge-uploader-fixture', () => {}, d.value), 'current')
    assert.deepEqual(d.installs, [])
  }))

test('automatic updates off keeps the installed plugin', () =>
  withPlugin('0.1.0', async () => {
    const d = deps({ isAutoUpdateEnabled: () => false })
    assert.equal(await ensurePluginCurrent('adb-bridge-uploader-fixture', () => {}, d.value), 'kept')
    assert.deepEqual(d.installs, [])
  }))

test('offline keeps the installed plugin', () =>
  withPlugin('0.1.0', async () => {
    const d = deps({ fetchLatest: async () => null })
    assert.equal(await ensurePluginCurrent('adb-bridge-uploader-fixture', () => {}, d.value), 'current')
    assert.deepEqual(d.installs, [])
  }))
