import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSaveWatcher } from '../src/save/save-watcher.mjs'

/**
 * A background scan must cost nothing when the save has not changed.
 *
 * Users saw a pull and an upload pass every minute with an idle emulator. The
 * watcher now stamps the emulator file before pulling and hashes what it
 * pulls; both are checked here by counting calls, not by reading the code.
 */
function fakeUploader(saves) {
  const calls = { acquire: 0, upload: 0 }
  let index = 0
  return {
    calls,
    uploader: {
      isLinked: () => true,
      isAutoUploadEnabled: () => true,
      acquireSaveBytes: async () => {
        calls.acquire += 1
        const bytes = saves[Math.min(index, saves.length - 1)]
        index += 1
        return { bytes, source: 'emulator', deviceSerial: '127.0.0.1:5555', remotePath: '/sdcard/save.dat' }
      },
      upload: async () => {
        calls.upload += 1
        return { messages: [] }
      },
    },
  }
}

test('an unchanged pull is not uploaded again', async () => {
  const { uploader, calls } = fakeUploader([Buffer.from('same'), Buffer.from('same')])
  // No stamp available: every scan pulls, so only the hash can stop the upload.
  const watcher = createSaveWatcher({ uploader, log: () => {}, probeRemoteSaveStamp: async () => null })
  await watcher.scanNow()
  await watcher.scanNow()
  assert.equal(calls.acquire, 2)
  assert.equal(calls.upload, 1)
})

test('an unchanged emulator stamp skips the pull entirely', async () => {
  // One probe after each pull, one before each later scan.
  const stamps = ['A', 'A', 'B', 'B']
  const { uploader, calls } = fakeUploader([Buffer.from('one'), Buffer.from('two')])
  const watcher = createSaveWatcher({
    uploader,
    log: () => {},
    probeRemoteSaveStamp: async () => stamps.shift() ?? 'B',
  })
  await watcher.scanNow() // first ever: pulls, then stamps A
  await watcher.scanNow() // stamp A again: no pull
  assert.equal(calls.acquire, 1)
  await watcher.scanNow() // stamp B: pulls the changed save
  assert.equal(calls.acquire, 2)
  assert.equal(calls.upload, 2)
})

test('a requested upload runs even when nothing changed', async () => {
  const { uploader, calls } = fakeUploader([Buffer.from('same')])
  const watcher = createSaveWatcher({ uploader, log: () => {}, probeRemoteSaveStamp: async () => 'A' })
  await watcher.scanNow()
  await watcher.uploadNow()
  assert.equal(calls.upload, 2)
})

test('a failed stamp probe falls back to pulling', async () => {
  const { uploader, calls } = fakeUploader([Buffer.from('one'), Buffer.from('two')])
  const watcher = createSaveWatcher({ uploader, log: () => {}, probeRemoteSaveStamp: async () => null })
  await watcher.scanNow()
  await watcher.scanNow()
  assert.equal(calls.acquire, 2, 'with no stamp the watcher must not assume the save is unchanged')
  assert.equal(calls.upload, 2)
})
