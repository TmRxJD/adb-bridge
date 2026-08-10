import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NO_UPLOADER, loadUploaderForProfile, supportsLinking } from '../src/upload/uploader-plugin.mjs'
import { normalizeGameProfile } from '../src/games/profile-schema.mjs'

/**
 * The contract between adb-bridge and a game's uploader.
 *
 * The properties that matter are the failure ones: a game with no uploader, or
 * one naming a plugin that is not installed, must still work as a plain save
 * bridge. Getting that wrong means an optional feature can break the whole
 * bridge for someone who never asked for it.
 */
function profile(overrides = {}) {
  return normalizeGameProfile({
    id: 'testgame',
    name: 'Test Game',
    port: 45111,
    androidPackages: ['com.example.testgame'],
    saveFilename: 'save.dat',
    allowedOrigins: ['https://example.com'],
    ...overrides,
  })
}

test('a game with no uploader gets the no-op, with no error', async () => {
  const { uploader, error } = await loadUploaderForProfile(profile(), () => {})
  assert.equal(uploader, NO_UPLOADER)
  assert.equal(error, null)
})

test('a named plugin that is not installed is normal, not an error', async () => {
  // Most people will not have any uploader installed. Reporting that as a
  // failure would put a scary line in front of every one of them.
  const logged = []
  const { uploader, error } = await loadUploaderForProfile(
    profile({ uploader: 'adb-bridge-uploader-does-not-exist' }),
    message => logged.push(message),
  )
  assert.equal(uploader, NO_UPLOADER)
  assert.equal(error, null)
  assert.deepEqual(logged, [], 'a missing optional plugin should say nothing')
})

test('the no-op uploader is safe to call', async () => {
  // save-watcher calls these on every save write, whether or not a plugin
  // exists, so none of them may throw.
  assert.equal(NO_UPLOADER.isLinked(), false)
  assert.equal(NO_UPLOADER.isAutoUploadEnabled(), false)
  assert.equal(await NO_UPLOADER.acquireSaveBytes(), null)
  assert.deepEqual((await NO_UPLOADER.upload(Buffer.from('x'))).messages, [])
})

test('supportsLinking distinguishes upload-only from account-linking plugins', () => {
  assert.equal(supportsLinking(NO_UPLOADER), false)

  const uploadOnly = {
    isLinked: () => true,
    isAutoUploadEnabled: () => true,
    upload: async () => ({}),
  }
  assert.equal(supportsLinking(uploadOnly), false, 'no link/unlink/describe means no linking')

  const full = {
    ...uploadOnly,
    link: async () => ({}),
    unlink: async () => {},
    describeLink: () => ({}),
  }
  assert.equal(supportsLinking(full), true)
})

test('a plugin that does not implement the contract is rejected and reported', async () => {
  // Distinct from "not installed": the user installed this on purpose, so
  // silently ignoring it would leave uploads mysteriously doing nothing.
  const logged = []
  const { uploader, error } = await loadUploaderForProfile(
    // node: URLs always resolve, so this stands in for an installed-but-wrong module.
    profile({ uploader: 'node:os' }),
    message => logged.push(message),
  )
  assert.equal(uploader, NO_UPLOADER)
  assert.match(error ?? '', /does not look like an uploader plugin/)
  assert.equal(logged.length, 1)
})
