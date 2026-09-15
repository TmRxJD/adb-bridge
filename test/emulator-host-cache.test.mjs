import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildKnownHosts } from '../src/save/pull-save.mjs'
import { normalizeEmulatorHost } from '../src/bridge-config.mjs'
import { KNOWN_EMULATOR_ADB_HOSTS } from '../src/save/device-paths.mjs'

/**
 * The bridge remembers the emulator address its last pull used and tries it first,
 * so a reconnect is one `adb connect` rather than a probe of every known port.
 */
const REMEMBERED = '127.0.0.1:16384'

test('the remembered emulator host is tried before the known defaults', () => {
  const hosts = buildKnownHosts(undefined, REMEMBERED)
  assert.equal(hosts[0], REMEMBERED)
  assert.equal(new Set(hosts).size, hosts.length, 'no host is listed twice')
  for (const known of KNOWN_EMULATOR_ADB_HOSTS) assert.ok(hosts.includes(known), `${known} still probed as a fallback`)
})

test('a custom port the user typed still comes first', () => {
  const hosts = buildKnownHosts('5555', REMEMBERED)
  assert.deepEqual(hosts.slice(0, 2), ['127.0.0.1:5555', REMEMBERED])
})

test('with nothing remembered the order is unchanged', () => {
  assert.deepEqual(buildKnownHosts(undefined, null), buildKnownHosts(undefined))
})

test('only a TCP emulator address is remembered', () => {
  assert.equal(normalizeEmulatorHost(' 127.0.0.1:16384 '), REMEMBERED)
  assert.equal(normalizeEmulatorHost('emulator-5554'), null, 'the serial form names no port to connect to')
  assert.equal(normalizeEmulatorHost('R58M123ABC'), null, 'a USB phone serial is not an emulator host')
  assert.equal(normalizeEmulatorHost(42), null)
  assert.equal(buildKnownHosts(undefined, 'emulator-5554')[0], KNOWN_EMULATOR_ADB_HOSTS[0])
})
