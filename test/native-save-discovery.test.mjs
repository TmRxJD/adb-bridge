import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadAllGameProfiles } from '../src/games/registry.mjs'
import { buildNativeHostSaveCandidates, discoverNativeHostSave, walkForSave } from '../src/save/native-save-discovery.mjs'

const { profiles } = loadAllGameProfiles()
const tower = profiles.get('thetower')
const payload = Buffer.from(JSON.stringify({ exported: true, padding: 'x'.repeat(100) }))

async function fixture(t) {
  const root = path.join(os.tmpdir(), 'adb-bridge-tests')
  await fs.mkdir(root, { recursive: true })
  const home = await fs.mkdtemp(path.join(root, 'native-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  t.mock.method(os, 'homedir', () => home)
  return home
}

async function write(home, relative, bytes = payload) {
  const file = path.join(home, ...relative.split('/'))
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, bytes)
  return file
}

test('native candidate paths include all Tower filenames on every supported platform', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const candidates = buildNativeHostSaveCandidates(tower, platform)
    assert.deepEqual([...new Set(candidates.map(c => path.basename(c.absolutePath)))],
      ['tool_export.json', 'playerInfo.dat', 'PlayerInfo.dat'])
    assert.equal(new Set(candidates.map(c => c.absolutePath)).size, candidates.length)
  }
})

test('mac canonical Documents discovers official export before legacy save', async t => {
  const home = await fixture(t)
  const dir = 'Library/Containers/com.TechTreeGames.TheTower/Data/Documents/'
  await write(home, dir + 'playerInfo.dat', Buffer.alloc(4096, 'd'))
  const expected = await write(home, dir + 'tool_export.json')
  const result = await discoverNativeHostSave(tower, 'darwin')
  assert.equal(result.absolutePath, expected)
  assert.deepEqual(result.bytes, payload)
  assert.ok(result.bytes.byteLength < 4096)
})

for (const filename of ['playerInfo.dat', 'PlayerInfo.dat']) {
  test('mac falls back to ' + filename + ' when official export is absent or invalid', async t => {
    const home = await fixture(t)
    const dir = 'Library/Containers/com.TechTreeGames.TheTower/Data/Documents/'
    const expected = await write(home, dir + filename)
    assert.equal((await discoverNativeHostSave(tower, 'darwin')).absolutePath, expected)
    await write(home, dir + 'tool_export.json', Buffer.from('invalid'))
    assert.equal((await discoverNativeHostSave(tower, 'darwin')).absolutePath, expected)
  })
}

test('mac UUID and bounded walk discover exports and legacy fallbacks', async t => {
  const home = await fixture(t)
  const dir = 'Library/Containers/11111111-2222-3333-4444-555555555555/Data/'
  await write(home, dir + 'Library/Preferences/com.TechTreeGames.TheTower.plist')
  const legacy = await write(home, dir + 'Documents/playerInfo.dat')
  const exported = await write(home, dir + 'Documents/nested/TOOL_EXPORT.JSON')
  assert.equal((await discoverNativeHostSave(tower, 'darwin')).absolutePath, exported)
  await fs.unlink(exported)
  assert.equal((await discoverNativeHostSave(tower, 'darwin')).absolutePath, legacy)
  await fs.unlink(legacy)
  const nestedLegacy = await write(home, dir + 'Documents/nested/PlayerInfo.dat')
  assert.equal((await discoverNativeHostSave(tower, 'darwin')).absolutePath, nestedLegacy)
})

test('mac non-sandboxed Application Support discovers official export', async t => {
  const home = await fixture(t)
  const expected = await write(home, 'Library/Application Support/TechTreeGames/The Tower/tool_export.json')
  assert.equal((await discoverNativeHostSave(tower, 'darwin')).absolutePath, expected)
})

test('mac UUID legacy filename identifies a container whose smaller export is nested', async t => {
  const home = await fixture(t)
  const dir = 'Library/Containers/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/Data/Documents/'
  await write(home, dir + 'playerInfo.dat', Buffer.alloc(4096, 'd'))
  const expected = await write(home, dir + 'nested/tool_export.json')
  assert.equal((await discoverNativeHostSave(tower, 'darwin')).absolutePath, expected)
})

test('mac fallback walk prefers smaller JSON when both filenames share an unknown subfolder', async t => {
  const home = await fixture(t)
  const dir = 'Library/Application Support/UnknownTowerInstall/unknown-subfolder/'
  const legacy = await write(home, dir + 'playerInfo.dat', Buffer.alloc(4096, 'd'))
  const exported = await write(home, dir + 'tool_export.json')
  const result = await discoverNativeHostSave(tower, 'darwin')
  assert.equal(result.absolutePath, exported)
  assert.deepEqual(result.bytes, payload)
  assert.ok(result.bytes.byteLength < 4096)
  const desc = { saveFilenamesLower: ['tool_export.json', 'playerinfo.dat'] }
  const root = path.join(home, 'Library/Application Support/UnknownTowerInstall')
  assert.equal(await walkForSave(desc, [root]), exported)
  await fs.unlink(exported)
  assert.equal(await walkForSave(desc, [root]), legacy)
  assert.equal((await discoverNativeHostSave(tower, 'darwin')).absolutePath, legacy)
})

test('CIFI retains its filenames and remains unsupported on native macOS', async () => {
  const cifi = profiles.get('cifi')
  assert.equal(cifi.saveFilename, 'DATA.text')
  assert.deepEqual([...cifi.alternateSaveFilenames], ['CifiBackup.text'])
  assert.deepEqual(buildNativeHostSaveCandidates(cifi, 'darwin'), [])
  assert.equal(await discoverNativeHostSave(cifi, 'darwin'), null)
})


test('Windows LocalLow uses literal configured company/product paths and all filenames', t => {
  t.mock.method(os, 'homedir', () => path.resolve('fixture-home'))
  const candidates = buildNativeHostSaveCandidates(tower, 'win32')
  for (const filename of ['tool_export.json', 'playerInfo.dat', 'PlayerInfo.dat']) {
    assert.ok(candidates.some(c => c.absolutePath === path.resolve('fixture-home/AppData/LocalLow/TechTreeGames/The Tower', filename)))
    assert.ok(candidates.some(c => c.absolutePath.includes('LocalState') && path.basename(c.absolutePath) === filename))
  }
})

test('Linux Unity paths use configured segments with default and custom XDG_CONFIG_HOME', async t => {
  const home = await fixture(t)
  const original = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (original === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = original
  })
  delete process.env.XDG_CONFIG_HOME
  const defaults = buildNativeHostSaveCandidates(tower, 'linux')
  for (const filename of ['tool_export.json', 'playerInfo.dat', 'PlayerInfo.dat']) {
    assert.ok(defaults.some(c => c.absolutePath === path.join(home, '.config/unity3d/TechTreeGames/The Tower', filename)))
    assert.ok(defaults.some(c => c.absolutePath.includes('waydroid') && path.basename(c.absolutePath) === filename))
  }
  process.env.XDG_CONFIG_HOME = path.join(home, 'custom-config')
  const exported = await write(home, 'custom-config/unity3d/TechTreeGames/The Tower/tool_export.json')
  assert.equal((await discoverNativeHostSave(tower, 'linux')).absolutePath, exported)
  await fs.unlink(exported)
  const legacy = await write(home, 'custom-config/unity3d/TechTreeGames/The Tower/playerInfo.dat')
  assert.equal((await discoverNativeHostSave(tower, 'linux')).absolutePath, legacy)
  await fs.unlink(legacy)
  const capitalLegacy = await write(home, 'custom-config/unity3d/TechTreeGames/The Tower/PlayerInfo.dat')
  const result = await discoverNativeHostSave(tower, 'linux')
  assert.equal(result.absolutePath.toLowerCase(), capitalLegacy.toLowerCase())
  assert.deepEqual(result.bytes, payload)
})

test('profiles without nativeHost get no guessed Unity paths', () => {
  const cifi = profiles.get('cifi')
  for (const platform of ['win32', 'linux']) {
    const candidates = buildNativeHostSaveCandidates(cifi, platform)
    assert.ok(candidates.length > 0)
    assert.ok(candidates.every(c => !c.absolutePath.includes('LocalLow') && !c.absolutePath.includes('unity3d')))
  }
  const withoutPaths = { ...tower, nativeHost: { macBundleId: tower.nativeHost.macBundleId } }
  for (const platform of ['win32', 'linux']) {
    assert.ok(buildNativeHostSaveCandidates(withoutPaths, platform).every(c => !c.absolutePath.includes('LocalLow') && !c.absolutePath.includes('unity3d')))
  }
})
