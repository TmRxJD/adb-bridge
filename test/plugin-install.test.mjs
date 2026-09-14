import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isValidPluginName } from '../src/upload/plugin-install.mjs'
import { NO_UPLOADER, loadUploaderForProfile } from '../src/upload/uploader-plugin.mjs'
import { normalizeGameProfile } from '../src/games/profile-schema.mjs'

/**
 * A plugin installed beside the bridge, not inside it, must still load.
 *
 * Under Volta every global tool is an isolated image, so a bare import from
 * adb-bridge never saw the uploader and background uploads silently never ran.
 */
function profile(uploader) {
  return normalizeGameProfile({
    id: 'testgame',
    name: 'Test Game',
    port: 45112,
    androidPackages: ['com.example.testgame'],
    saveFilename: 'save.dat',
    allowedOrigins: ['https://example.com'],
    uploader,
  })
}

test('an uploader in the bridge plugins folder is found and loaded', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-bridge-home-'))
  const previousHome = process.env.ADB_BRIDGE_HOME
  process.env.ADB_BRIDGE_HOME = home
  try {
    const dir = path.join(home, 'plugins', 'node_modules', 'adb-bridge-uploader-fixture')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'adb-bridge-uploader-fixture', type: 'module', exports: { '.': './index.mjs' } }))
    fs.writeFileSync(
      path.join(dir, 'index.mjs'),
      'export default { fixture: true, isLinked: () => false, isAutoUploadEnabled: () => false, upload: async () => ({}) }\n',
    )
    const { uploader, error } = await loadUploaderForProfile(profile('adb-bridge-uploader-fixture'), () => {})
    assert.equal(error, null)
    assert.notEqual(uploader, NO_UPLOADER)
    assert.equal(uploader.fixture, true)
  } finally {
    if (previousHome === undefined) delete process.env.ADB_BRIDGE_HOME
    else process.env.ADB_BRIDGE_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('plugin names that could reach a shell are refused', () => {
  assert.equal(isValidPluginName('adb-bridge-uploader-thetower'), true)
  assert.equal(isValidPluginName('@scope/pkg'), true)
  for (const bad of ['a & calc', 'x;rm -rf', '../evil', 'Name', '', 'a|b']) {
    assert.equal(isValidPluginName(bad), false, bad)
  }
})
