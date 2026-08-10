import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeGameProfile } from '../src/games/profile-schema.mjs'
import { findPortConflicts, loadAllGameProfiles } from '../src/games/registry.mjs'
import { buildEmulatorPullPaths, buildUsbPullPaths } from '../src/save/device-paths.mjs'

const VALID = {
  id: 'mygame',
  name: 'My Game',
  port: 43801,
  androidPackages: ['com.example.mygame'],
  saveFilename: 'save.dat',
  allowedOrigins: ['https://example.com'],
}

function build(overrides) {
  return normalizeGameProfile({ ...VALID, ...overrides })
}

test('accepts a minimal valid profile', () => {
  const profile = build({})
  assert.equal(profile.id, 'mygame')
  assert.equal(profile.port, 43801)
  assert.deepEqual([...profile.alternateSaveFilenames], [])
})

test('rejects the mistakes a hand-written profile actually makes', () => {
  const cases = [
    [{ id: 'My Game' }, /lowercase letters/],
    [{ port: 80 }, /between 1024/],
    [{ port: 43801.5 }, /whole number/],
    [{ androidPackages: [] }, /at least one Android package/],
    [{ androidPackages: ['notapackage'] }, /does not look like an Android package/],
    [{ saveFilename: 'files/save.dat' }, /bare filename, not a path/],
    [{ saveFilename: '' }, /"saveFilename" is required/],
    [{ allowedOrigins: [] }, /at least one site origin/],
    [{ allowedOrigins: ['*'] }, /cannot be "\*"/],
    [{ allowedOrigins: ['https://example.com/app'] }, /bare origin/],
    [{ extraDevicePaths: ['relative/path'] }, /absolute device paths/],
    [{ alternateSaveFilenames: ['a/b.dat'] }, /bare filenames/],
  ]
  for (const [overrides, expected] of cases) {
    assert.throws(() => build(overrides), expected, `expected ${JSON.stringify(overrides)} to be rejected`)
  }
})

test('a wildcard origin is refused because the bridge serves save bytes', () => {
  assert.throws(() => build({ allowedOrigins: ['*'] }), /save-file bytes/)
})

test('both built-in games load and claim distinct ports', () => {
  const { profiles, errors } = loadAllGameProfiles()
  assert.deepEqual(errors, [], 'built-in profiles must always be valid')

  const tower = profiles.get('thetower')
  const cifi = profiles.get('cifi')
  assert.ok(tower, 'thetower profile missing')
  assert.ok(cifi, 'cifi profile missing')

  assert.equal(tower.port, 43781, 'the deployed tracker site connects to this port')
  assert.equal(cifi.port, 43791, 'the deployed CIFI site connects to this port')
  assert.deepEqual(findPortConflicts([...profiles.values()]), [])
})

test('built-in profiles keep the save filenames confirmed on real devices', () => {
  const { profiles } = loadAllGameProfiles()
  assert.equal(profiles.get('thetower').saveFilename, 'playerInfo.dat')
  assert.equal(profiles.get('cifi').saveFilename, 'DATA.text')
  // CIFI's rolling backup is a real second file, not a spelling variant.
  assert.deepEqual([...profiles.get('cifi').alternateSaveFilenames], ['CifiBackup.text'])
})

test('port conflicts are reported rather than silently serving the wrong game', () => {
  const a = build({ id: 'a', port: 43900 })
  const b = build({ id: 'b', port: 43900 })
  const conflicts = findPortConflicts([a, b])
  assert.equal(conflicts.length, 1)
  assert.match(conflicts[0], /43900/)
})

test('USB order probes Download before the app directory', () => {
  const { profiles } = loadAllGameProfiles()
  const paths = buildUsbPullPaths(profiles.get('thetower'))
  const firstDownload = paths.findIndex(p => p.includes('/Download/'))
  const firstAppData = paths.findIndex(p => p.includes('/Android/data/'))
  // On a non-rooted phone /Android/data is unreadable, so probing it first
  // made every USB pull wait on a guaranteed failure.
  assert.ok(firstDownload >= 0 && firstAppData >= 0)
  assert.ok(firstDownload < firstAppData, 'Download must be probed first over USB')
})

test('emulator order probes the app directory before Download', () => {
  const { profiles } = loadAllGameProfiles()
  const paths = buildEmulatorPullPaths(profiles.get('thetower'))
  const firstDownload = paths.findIndex(p => p.includes('/Download/'))
  const firstAppData = paths.findIndex(p => p.includes('/Android/data/'))
  assert.ok(firstAppData < firstDownload, 'app data must be probed first on an emulator')
})

test('the internal /data/data path is always tried last', () => {
  const { profiles } = loadAllGameProfiles()
  for (const build of [buildUsbPullPaths, buildEmulatorPullPaths]) {
    const paths = build(profiles.get('thetower'))
    const firstInternal = paths.findIndex(p => p.startsWith('/data/data/'))
    assert.ok(firstInternal > 0)
    // It needs root, so it usually fails; failing costs a round trip.
    assert.ok(
      paths.slice(firstInternal).every(p => p.startsWith('/data/data/')),
      'nothing may be probed after the root-only paths',
    )
  }
})

test('paths cover every package and filename, with no duplicates', () => {
  const { profiles } = loadAllGameProfiles()
  const tower = profiles.get('thetower')
  const paths = buildUsbPullPaths(tower)
  assert.equal(new Set(paths).size, paths.length, 'duplicate probes waste a round trip each')
  for (const pkg of tower.androidPackages) {
    assert.ok(paths.some(p => p.includes(pkg)), `no path covers ${pkg}`)
  }
  // The legacy spelling is what some installs actually write.
  assert.ok(paths.some(p => p.endsWith('/PlayerInfo.dat')))
})

test('a user profile overrides a built-in of the same id', () => {
  // This is the escape hatch for "the game moved its save and no release has
  // caught up yet", so it must actually replace rather than be ignored.
  const overridden = normalizeGameProfile(
    { ...VALID, id: 'thetower', port: 43781 },
    { source: 'user.json', builtin: false },
  )
  assert.equal(overridden.builtin, false)
  assert.equal(overridden.saveFilename, 'save.dat')
})
